// Fixture server plus a stand-in for CPA's /v1/evaluations. The stand-in
// speaks Jev's wire format and answers with simple rules; it proves the
// integration, not the quality of Jev's judgments.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TYPES = { '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png' };

function argmaxChoice(criteria, pick) {
  const keys = Object.keys(criteria);
  const choice = keys.includes(pick) ? pick : keys[0];
  const probabilities = Object.fromEntries(keys.map((k) => [k, k === choice ? 0.86 : 0.14 / (keys.length - 1)]));
  return { type: 'choice', choice, probabilities };
}

function answer(name, q, state, mode) {
  if (q.type === 'score') {
    const levels = q.criteria.length;
    if (name === 'quality') return { type: 'score', score: levels - 1.2 };
    return { type: 'score', score: (levels - 1) / 2 };
  }
  if (q.type === 'boolean') return { type: 'boolean', probability: 0.5 };
  let pick;
  if (name === 'surface_tone') pick = (state.page?.brandColors?.[0]?.screenShare ?? 0) > 0.2 ? 'brand' : 'neutral';
  else if (name === 'accent_policy') pick = 'keep';
  else if (name === 'adjust') pick = state.userFeedback ? (/read/.test(state.userFeedback) ? 'raise_contrast' : /bright/.test(state.userFeedback) ? 'darker' : 'lighter') : 'none';
  else if (name.startsWith('role_')) {
    const e = state.elements[name.slice(5)];
    if (mode.keepRoleColor === e.color) return argmaxChoice(q.criteria, 'keep');
    pick = e.areaOfViewport > 0.12 || e.lightness > 0.85 ? 'surface' : e.widthOfViewport < 0.12 && e.heightPx < 80 && !e.textLength ? 'keep' : 'accent';
  } else if (name.startsWith('image_')) {
    const i = state.images[name.slice(6)];
    const px = i.pixels;
    pick = px && px.meanSaturation < 0.15 && (px.transparentFraction > 0.3 || px.nearWhiteFraction > 0.5) ? 'invert' : 'keep';
  }
  return argmaxChoice(q.criteria, pick);
}

export function start({ port = 8765, root, log }) {
  const mode = { fail: false };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/evaluations') && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        log.push({ auth: req.headers.authorization, body: parsed, raw: body });
        if (mode.fail) {
          res.writeHead(502, { 'content-type': 'application/json' });
          return res.end('{"error":"upstream evaluation failed"}');
        }
        const answers = Object.fromEntries(Object.entries(parsed.questions).map(([n, q]) => [n, answer(n, q, parsed.state, mode)]));
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ answers, model: 'typesafe-ai/jev' }));
        }, 120);
      });
      return;
    }
    const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, mode })));
}
