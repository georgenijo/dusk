// Dusk content script.
//
// Two layers:
//   1. A deterministic OKLCH engine that paints a dark theme immediately, from
//      local priors, so there is never a white flash.
//   2. Jev, which makes the judgment calls the priors can only guess at: the
//      site's palette, what each colored surface is, how each image should be
//      treated, and whether the finished result is good enough. Jev's answers
//      are cached per site, so the next visit starts from them.
(() => {
  if (window.top !== window || !/^https?:$|^file:$/.test(location.protocol)) return;
  const C = DuskColor;
  const host = location.hostname || 'local-file';
  const KEY = 'site:' + host;
  const ATTR = 'data-dusk';
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'BR', 'WBR', 'SOURCE', 'TRACK', 'PARAM']);
  const MEDIA = new Set(['IMG', 'PICTURE', 'VIDEO', 'CANVAS', 'IFRAME', 'EMBED', 'OBJECT']);
  const INTERACTIVE = 'a,button,input,select,textarea,label,summary,[role=button],[role=tab],[role=menuitem],.btn,.button,.badge,.tag,.chip,.pill';
  // Pages Jev never sees, even as structure: finance, mail, health, government.
  const PRIVATE_HOST = /(^|[.-])(bank|banking|credit|paypal|venmo|chase|wellsfargo|schwab|fidelity|vanguard|mail|outlook|proton|health|patient|mychart|irs|ssa|login|accounts?)([.-]|$)/i;
  const FILENAME_HINTS = ['logo', 'icon', 'avatar', 'photo', 'hero', 'banner', 'diagram', 'chart', 'graph', 'screenshot', 'sprite', 'badge', 'emoji', 'thumb', 'illustration', 'background', 'bg', 'pattern'];

  const TONES = {
    neutral: { H: 265, C: 0.006 },
    cool: { H: 250, C: 0.02 },
    warm: { H: 60, C: 0.014 },
  };
  const DEPTHS = [0.13, 0.17, 0.215];
  const DEFAULT_THEME = { surfaceL: 0.17, tone: 'neutral', surfaceHue: 265, surfaceChroma: 0.006, textL: 0.92, accent: 'keep', minContrast: 4.5, imageDim: 0.9 };

  let profile = null;
  let enabled = false;
  let theme = { ...DEFAULT_THEME };
  const saved = new WeakMap();   // el -> { prop: { orig: [value, priority], ours } }
  const effBg = new WeakMap();   // el -> opaque rgb behind the element after theming
  const roleOf = new WeakMap();  // el -> { sig, role, lch, area }
  // Per-element tallies, summed over the live DOM on demand, so re-themed or
  // removed elements are never double counted.
  // Event log for diagnostics. Records what Dusk decided and why, never page
  // text or URLs. Mirrored to the console when settings.debug is on.
  const events = [];
  let debugConsole = false;
  chrome.storage.local.get('settings').then(({ settings }) => (debugConsole = !!settings?.debug)).catch(() => {});
  function log(kind, data = {}) {
    events.push({ t: Math.round(performance.now()), kind, ...data });
    if (events.length > 300) events.shift();
    if (debugConsole) console.debug('[Dusk]', kind, data);
  }

  const tally = new WeakMap();
  function count(el, key) {
    let t = tally.get(el);
    if (!t) tally.set(el, (t = {}));
    t[key] = (t[key] || 0) + 1;
  }
  function liveStats() {
    const s = { elements: 0, text: 0, lowContrast: 0, accents: 0, images: { keep: 0, dim: 0, invert: 0, backdrop: 0 } };
    for (const el of document.getElementsByTagName('*')) {
      const t = tally.get(el);
      if (!t) continue;
      s.elements += t.elements || 0;
      s.text += t.text || 0;
      s.lowContrast += t.lowContrast || 0;
      s.accents += t.accents || 0;
      if (t.image) s.images[t.image]++;
    }
    return s;
  }
  const pendingRoles = new Map();  // sig -> element description for Jev
  const pendingImages = new Map(); // key -> { els, meta }
  const status = { mode: 'starting', native: null, jev: { calls: 0, lastError: null, lastMs: null, decisions: 0 }, quality: null, adjustments: [] };

  // ---------------------------------------------------------------- preflight
  const preflight = document.createElement('style');
  preflight.id = 'dusk-preflight';
  preflight.textContent = 'html,body{background-color:#1c1d21!important;color-scheme:dark}';
  (document.head || document.documentElement).appendChild(preflight);

  const base = document.createElement('style');
  base.id = 'dusk-base';
  // ::before/::after can't take inline styles; they get rules keyed by id.
  const pseudoSheet = document.createElement('style');
  pseudoSheet.id = 'dusk-pseudo';
  const pseudoRules = new Map(); // "id::after" -> css text
  let pseudoSeq = 0, pseudoQueued = false;
  function setPseudo(el, pseudo, decls) {
    const id = el.getAttribute('data-dusk-pid') || String(++pseudoSeq);
    el.setAttribute('data-dusk-pid', id);
    pseudoRules.set(id + pseudo, `[data-dusk-pid="${id}"]${pseudo}{${decls.map((d) => d + '!important').join(';')}}`);
    if (!pseudoQueued) {
      pseudoQueued = true;
      queueMicrotask(() => {
        pseudoQueued = false;
        pseudoSheet.textContent = [...pseudoRules.values()].join('\n');
      });
    }
  }
  function clearPseudo(el) {
    const id = el.getAttribute('data-dusk-pid');
    if (!id) return;
    pseudoRules.delete(id + '::before');
    pseudoRules.delete(id + '::after');
  }

  // ---------------------------------------------------------------- storage
  async function loadProfile() {
    const got = await chrome.storage.local.get(KEY);
    return got[KEY] || { mode: 'auto', theme: null, roles: {}, images: {}, overrides: {}, native: null, history: [], jevAt: 0 };
  }
  let saveTimer = 0;
  function saveNow() {
    clearTimeout(saveTimer);
    return chrome.storage.local.set({ [KEY]: profile });
  }
  function saveProfile() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => chrome.storage.local.set({ [KEY]: profile }), 400);
  }

  // ---------------------------------------------------------------- style writes
  function setProp(el, prop, value) {
    let s = saved.get(el);
    if (!s) saved.set(el, (s = {}));
    if (!s[prop]) s[prop] = { orig: [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)] };
    s[prop].ours = value;
    el.style.setProperty(prop, value, 'important');
    markOwn(el);
  }

  // The style attribute as we last left it. A style mutation whose element
  // still has exactly this value was ours and is ignored by the observer.
  const ownStyle = new WeakMap();
  function markOwn(el) {
    ownStyle.set(el, el.getAttribute('style'));
  }

  // Undo our writes. If the page replaced one of our values meanwhile, the
  // page's value wins and becomes the new original.
  function unapply(el) {
    const s = saved.get(el);
    if (!s) return;
    for (const prop in s) {
      const cur = el.style.getPropertyValue(prop);
      if (cur === s[prop].ours && el.style.getPropertyPriority(prop) === 'important') {
        const [v, p] = s[prop].orig;
        if (v) el.style.setProperty(prop, v, p);
        else el.style.removeProperty(prop);
      }
    }
    saved.delete(el);
    el.removeAttribute(ATTR);
    markOwn(el);
  }
  function unapplyAll(el) {
    unapply(el);
    clearPseudo(el);
  }

  // ---------------------------------------------------------------- color mapping
  const lchOf = (rgb) => C.toOklch(rgb);
  const toRgb = (lch) => C.fromOklch(lch);

  function mapSurface(lch) {
    const b = theme.surfaceL;
    const L = lch.L >= 0.5 ? b + (1 - lch.L) * 0.3 : (lch.L * (b + 0.15)) / 0.5;
    const tinted = lch.C < 0.03;
    return { L, C: tinted ? theme.surfaceChroma : Math.min(lch.C * 0.55, 0.07), H: tinted ? theme.surfaceHue : lch.H, a: lch.a };
  }

  function mapAccent(lch) {
    // Pale tints (notes, callouts, highlights) become slightly lifted, tinted surfaces.
    if (lch.L > 0.85) return { L: theme.surfaceL + 0.07, C: Math.min(lch.C * 0.8, 0.045), H: lch.H, a: lch.a };
    // Muted accents lose some glare but stay recognizably the brand color.
    if (theme.accent === 'mute') return { L: C.clamp(lch.L * 0.8, 0.45, 0.6), C: lch.C * 0.75, H: lch.H, a: lch.a };
    return { L: C.clamp(lch.L, 0.42, 0.68), C: lch.C, H: lch.H, a: lch.a };
  }

  function mapText(lch) {
    if (lch.L >= 0.62) return lch;
    return { L: theme.textL - lch.L * 0.3, C: lch.C > 0.05 ? lch.C : lch.C * 0.5, H: lch.H, a: lch.a };
  }

  function mapBorder(lch) {
    if (lch.L > 0.5) {
      const s = mapSurface(lch);
      return { ...s, L: s.L + 0.1 };
    }
    return { L: 0.78 - lch.L * 0.3, C: lch.C, H: lch.H, a: lch.a };
  }

  function ensureContrast(fg, bg, min, original) {
    let rgb = toRgb(fg);
    const solid = C.over(rgb, bg);
    if (C.contrast(solid, bg) >= min) return rgb;
    if (original && C.contrast(C.over(original, bg), bg) >= min) return original;
    const dir = lchOf(bg).L < 0.6 ? 1 : -1;
    let L = fg.L;
    for (let i = 0; i < 24; i++) {
      L = C.clamp(L + dir * 0.03, 0, 1);
      rgb = toRgb({ ...fg, L, a: Math.max(fg.a, 0.9) });
      if (C.contrast(C.over(rgb, bg), bg) >= min) break;
    }
    return rgb;
  }

  function mapBg(el, rgb, rect) {
    const lch = lchOf(rgb);
    const role = bgRole(el, lch, rect);
    if (role === 'keep') return rgb;
    return toRgb(role === 'accent' ? mapAccent(lch) : mapSurface(lch));
  }

  // ---------------------------------------------------------------- roles
  function classTokens(el) {
    const cls = typeof el.className === 'string' ? el.className : el.getAttribute('class') || '';
    return cls.split(/\s+/).filter((t) => t && t.length <= 32 && !/\d{3,}/.test(t)).slice(0, 4);
  }

  function signature(el, rgb) {
    return `${el.tagName.toLowerCase()}.${classTokens(el).sort().join('.')}|${C.hex(rgb)}`;
  }

  function bgRole(el, lch, rect) {
    const sig = signature(el, toRgb(lch));
    if (lch.C < 0.045) {
      const role = profile.overrides[sig] || 'surface';
      roleOf.set(el, { sig, role, lch, area: 0 });
      return role;
    }
    const vw = innerWidth || 1, vh = innerHeight || 1;
    const area = (Math.min(rect.width, vw) * Math.min(rect.height, vh * 3)) / (vw * vh);
    let role = profile.overrides[sig] || profile.roles[sig]?.role;
    if (!role) {
      const interactive = el.matches(INTERACTIVE);
      role = area >= 0.12 ? 'surface' : interactive || area < 0.03 ? 'accent' : lch.L > 0.82 ? 'surface' : 'accent';
      if (!pendingRoles.has(sig)) pendingRoles.set(sig, describe(el, lch, rect, area, interactive));
    }
    roleOf.set(el, { sig, role, lch, area });
    if (role === 'accent') count(el, 'accents');
    return role;
  }

  // Structure only: tag, class tokens, geometry, colors, counts. No text.
  function describe(el, lch, rect, area, interactive) {
    return {
      tag: el.tagName.toLowerCase(),
      ariaRole: el.getAttribute('role') || null,
      classes: classTokens(el),
      color: C.hex(toRgb(lch)),
      oklch: { L: +lch.L.toFixed(3), C: +lch.C.toFixed(3), H: Math.round(lch.H) },
      areaOfViewport: +area.toFixed(3),
      widthOfViewport: +(rect.width / (innerWidth || 1)).toFixed(2),
      heightPx: Math.round(rect.height),
      topOfPage: +((rect.top + scrollY) / Math.max(1, document.documentElement.scrollHeight)).toFixed(2),
      interactive,
      textLength: Math.min(5000, (el.textContent || '').trim().length),
      childElements: el.childElementCount,
      containsImages: !!el.querySelector('img,svg,picture'),
    };
  }

  // ---------------------------------------------------------------- images
  // backdrop: photos on a white studio backdrop. Darkened further than dim so
  // the backdrop reads as a soft light tile instead of a glaring hole.
  const FILTERS = {
    keep: '',
    dim: () => `brightness(${theme.imageDim})`,
    invert: 'invert(0.9) hue-rotate(180deg)',
    backdrop: () => `brightness(${(theme.imageDim * 0.86).toFixed(3)}) contrast(1.06)`,
  };

  function imageKey(url) {
    try {
      const u = new URL(url, location.href);
      return u.protocol === 'data:' ? 'data:' + url.length + ':' + url.slice(-48) : u.origin + u.pathname;
    } catch {
      return url.slice(0, 200);
    }
  }

  function imageMeta(el, url, rect, kind) {
    let ext = '';
    try { ext = (new URL(url, location.href).pathname.match(/\.([a-z0-9]{2,5})$/i) || [])[1] || ''; } catch {}
    if (url.startsWith('data:image/svg')) ext = 'svg';
    const name = decodeURIComponent((url.split(/[?#]/)[0].split('/').pop() || '').toLowerCase());
    return {
      kind,
      ext: ext.toLowerCase(),
      filenameHints: FILENAME_HINTS.filter((h) => name.includes(h)),
      renderedWidth: Math.round(rect.width),
      renderedHeight: Math.round(rect.height),
      inLink: !!el.closest('a'),
      inHeaderOrNav: !!el.closest('header,nav,[role=banner],[role=navigation]'),
      inButton: !!el.closest('button,[role=button]'),
      hasAlt: kind === 'img' ? !!el.getAttribute('alt') : null,
    };
  }

  function priorTreatment(meta, px) {
    if (!px) {
      if (meta.ext === 'svg' || meta.filenameHints.includes('logo') || meta.filenameHints.includes('icon')) return 'keep';
      return meta.renderedWidth * meta.renderedHeight > 40000 ? 'dim' : 'keep';
    }
    if (px.transparentFraction > 0.3 && px.meanLightness < 0.35 && px.meanSaturation < 0.15) return 'invert';
    if (px.nearWhiteFraction > 0.55 && px.colorBuckets < 24 && px.meanSaturation < 0.15) return 'invert';
    if (px.edgeWhiteFraction > 0.8 && px.edgeTransparentFraction < 0.2) return 'backdrop';
    if (px.meanLightness > 0.7) return 'dim';
    return 'keep';
  }

  function applyImage(el, treatment) {
    const f = FILTERS[treatment];
    const value = typeof f === 'function' ? f() : f;
    if (value) setProp(el, 'filter', value);
    else if (saved.get(el)?.filter) {
      const s = saved.get(el);
      const [v, p] = s.filter.orig;
      if (v) el.style.setProperty('filter', v, p); else el.style.removeProperty('filter');
      delete s.filter;
      markOwn(el);
    }
    let t = tally.get(el);
    if (!t) tally.set(el, (t = {}));
    t.image = treatment;
  }

  function handleImage(el, url, rect, kind) {
    if (!url || rect.width < 8 || rect.height < 8) return;
    const key = imageKey(url);
    const known = profile.overrides['img:' + key] || profile.images[key]?.treatment;
    if (known) return applyImage(el, known);
    let entry = pendingImages.get(key);
    if (!entry) pendingImages.set(key, (entry = { url, els: [], meta: imageMeta(el, url, rect, kind), px: undefined }));
    entry.els.push(el);
    applyImage(el, priorTreatment(entry.meta, null));
  }

  // ---------------------------------------------------------------- engine
  function parentBg(el) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const b = effBg.get(p);
      if (b) return b;
    }
    return toRgb({ L: theme.surfaceL, C: theme.surfaceChroma, H: theme.surfaceHue, a: 1 });
  }

  // A running CSS transition makes getComputedStyle return an in-between
  // value, often the color we just removed. Cancel transitions while reading
  // so we see the page's real target colors, then hand them back.
  function process(el) {
    if (SKIP.has(el.tagName) || el.id?.startsWith?.('dusk-')) return;
    unapplyAll(el);
    tally.delete(el);
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return;
    if (!cs.transitionDuration.split(',').some((d) => parseFloat(d) > 0)) return processStyled(el, cs);
    const prev = [el.style.getPropertyValue('transition'), el.style.getPropertyPriority('transition')];
    el.style.setProperty('transition', 'none', 'important');
    try {
      processStyled(el, cs);
    } finally {
      if (prev[0]) el.style.setProperty('transition', prev[0], prev[1]);
      else el.style.removeProperty('transition');
      markOwn(el);
    }
  }

  function processStyled(el, cs) {
    count(el, 'elements');
    const behind = parentBg(el);
    let own = behind;
    let rect = null;
    const getRect = () => (rect ??= el.getBoundingClientRect());

    const root = el === document.documentElement || el === document.body;
    // Multiply-style blending (Amazon's product tiles) turns black over a dark
    // surface. Images and containers switch to normal blending; an empty
    // multiply layer is a tint over content and keeps its original color.
    const darkBlend = /^(multiply|darken|color-burn)$/.test(cs.mixBlendMode);
    const tintLayer = darkBlend && !el.firstElementChild && !MEDIA.has(el.tagName) && el.tagName !== 'IMG';
    if (darkBlend && !tintLayer) setProp(el, 'mix-blend-mode', 'normal');
    const bg = tintLayer ? null : C.parse(cs.backgroundColor);
    if (bg && bg.a > 0.01) {
      const mapped = mapBg(el, bg, getRect());
      setProp(el, 'background-color', C.format(mapped));
      own = C.over(mapped, behind);
    } else if (root) {
      const surface = toRgb({ L: theme.surfaceL, C: theme.surfaceChroma, H: theme.surfaceHue, a: 1 });
      setProp(el, 'background-color', C.format(surface));
      own = surface;
    }

    const bgImage = cs.backgroundImage;
    if (bgImage && bgImage !== 'none') {
      if (bgImage.includes('gradient(')) setProp(el, 'background-image', rewriteGradient(bgImage, (c) => mapBg(el, c, getRect())));
      const url = bgImage.match(/url\("?([^")]+)"?\)/);
      if (url && !el.querySelector('*')) handleImage(el, url[1], getRect(), 'background');
    }
    effBg.set(el, own);

    // Text: only write where the element sets its own color or contrast needs it.
    const fg = C.parse(cs.color);
    if (fg && (root || el.firstChild)) {
      const parentColor = el.parentElement ? getComputedStyle(el.parentElement).color : null;
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      const mapped = ensureContrast(mapText(lchOf(fg)), own, hasText ? theme.minContrast : 3, fg);
      const value = C.format(mapped);
      if (root || value !== parentColor || hasText) {
        if (value !== cs.color) setProp(el, 'color', value);
        if (hasText) {
          count(el, 'text');
          if (C.contrast(C.over(mapped, own), own) < theme.minContrast - 0.05) count(el, 'lowContrast');
        }
      }
    }

    for (const side of ['top', 'right', 'bottom', 'left']) {
      if (parseFloat(cs[`border-${side}-width`] ?? cs.getPropertyValue(`border-${side}-width`)) > 0) {
        const bc = C.parse(cs.getPropertyValue(`border-${side}-color`));
        if (bc && bc.a > 0.01) setProp(el, `border-${side}-color`, C.format(toRgb(mapBorder(lchOf(bc)))));
      }
    }

    if (el instanceof SVGElement && el.tagName !== 'svg') {
      for (const prop of ['fill', 'stroke']) {
        const c = C.parse(cs.getPropertyValue(prop));
        if (c && c.a > 0.01) {
          const lch = lchOf(c);
          const mapped = lch.C > 0.1 && lch.L > 0.3 ? c : ensureContrast(mapText(lch), own, 3, null);
          setProp(el, prop, C.format(mapped));
        }
      }
    }

    if (!(el instanceof SVGElement) && !MEDIA.has(el.tagName)) processPseudo(el, own, getComputedStyle(el).color);

    if (el.tagName === 'IMG' || el.tagName === 'image') {
      handleImage(el, el.currentSrc || el.src || el.getAttribute('href'), getRect(), 'img');
    } else if (el.tagName === 'VIDEO' || el.tagName === 'CANVAS') {
      // Leave moving content untouched; dimming video reads as broken.
    }
    if (saved.has(el)) el.setAttribute(ATTR, '');
  }

  function rewriteGradient(value, map) {
    return value.replace(/rgba?\([^)]*\)|color\([^)]*\)/g, (m) => {
      const c = C.parse(m);
      return c ? C.format(map(c)) : m;
    });
  }

  function processPseudo(el, own, parentColor) {
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(el, pseudo);
      if (ps.content === 'none' || ps.content === 'normal') continue;
      const decls = [];
      const bg = C.parse(ps.backgroundColor);
      if (bg && bg.a > 0.01) decls.push(`background-color:${C.format(toRgb(mapSurface(lchOf(bg))))}`);
      if (ps.backgroundImage.includes('gradient(')) decls.push(`background-image:${rewriteGradient(ps.backgroundImage, (c) => toRgb(mapSurface(lchOf(c))))}`);
      const fg = C.parse(ps.color);
      if (fg && ps.color !== parentColor) decls.push(`color:${C.format(ensureContrast(mapText(lchOf(fg)), own, 3, null))}`);
      for (const side of ['top', 'right', 'bottom', 'left']) {
        if (parseFloat(ps.getPropertyValue(`border-${side}-width`)) > 0) {
          const bc = C.parse(ps.getPropertyValue(`border-${side}-color`));
          if (bc && bc.a > 0.01) decls.push(`border-${side}-color:${C.format(toRgb(mapBorder(lchOf(bc))))}`);
        }
      }
      if (decls.length) setPseudo(el, pseudo, decls);
    }
  }

  function walk(rootEl, budgetMs = Infinity) {
    const start = performance.now();
    const tw = document.createTreeWalker(rootEl, NodeFilter.SHOW_ELEMENT);
    const queue = [rootEl];
    for (let n = tw.nextNode(); n; n = tw.nextNode()) queue.push(n);
    return new Promise((resolve) => {
      let i = 0;
      const step = () => {
        const t0 = performance.now();
        while (i < queue.length && (performance.now() - t0 < 12 || performance.now() - start < budgetMs)) {
          if (queue[i].isConnected) process(queue[i]);
          i++;
        }
        drain();
        if (i < queue.length) requestAnimationFrame(step); else resolve();
      };
      step();
    });
  }

  async function rethemeAll() {
    for (const el of document.querySelectorAll(`[${ATTR}],[data-dusk-pid]`)) unapplyAll(el);
    drain();
    await walk(document.documentElement);
  }

  function unthemeAll() {
    for (const el of document.querySelectorAll(`[${ATTR}],[data-dusk-pid]`)) unapplyAll(el);
    preflight.remove();
    base.remove();
    pseudoSheet.remove();
  }

  // ---------------------------------------------------------------- dynamic pages
  let observer = null;
  const dirty = new Set();
  let flushQueued = false;
  function queue(el) {
    dirty.add(el);
    if (!flushQueued) {
      flushQueued = true;
      requestAnimationFrame(flush);
    }
  }
  // Busy pages mutate every frame; log one summary per 2 s instead.
  const mutationTotals = { flushes: 0, roots: 0, ms: 0 };
  let mutationTimer = 0;
  function logMutations(roots, ms) {
    mutationTotals.flushes++;
    mutationTotals.roots += roots;
    mutationTotals.ms += ms;
    mutationTimer ||= setTimeout(() => {
      log('mutations', { flushes: mutationTotals.flushes, roots: mutationTotals.roots, ms: Math.round(mutationTotals.ms) });
      Object.assign(mutationTotals, { flushes: 0, roots: 0, ms: 0 });
      mutationTimer = 0;
    }, 2000);
  }
  async function flush() {
    flushQueued = false;
    if (!enabled) return dirty.clear();
    const roots = [...dirty].filter((el) => el.isConnected && ![...dirty].some((o) => o !== el && o.contains(el)));
    dirty.clear();
    const t0 = performance.now();
    for (const r of roots) await walk(r, 30);
    if (roots.length) logMutations(roots.length, performance.now() - t0);
    scheduleJev();
  }
  function handleMutations(records) {
    for (const r of records) {
      if (r.type === 'childList') r.addedNodes.forEach((n) => n.nodeType === 1 && !n.id?.startsWith?.('dusk-') && queue(n));
      else if (r.target.nodeType === 1 && !SKIP.has(r.target.tagName)) {
        if (r.attributeName === 'style' && r.target.getAttribute('style') === ownStyle.get(r.target)) continue;
        queue(r.target);
      }
    }
  }
  // Hand pending records to the handler now, so page mutations that arrive
  // while we write are kept and only our own writes are dropped.
  function drain() {
    if (observer) handleMutations(observer.takeRecords());
  }
  function observe() {
    observer = new MutationObserver(handleMutations);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'src', 'srcset'] });
  }

  // ---------------------------------------------------------------- native dark detection
  function pageLooksDark() {
    preflight.disabled = true;
    const read = (el) => el && C.parse(getComputedStyle(el).backgroundColor);
    let bg = read(document.body);
    if (!bg || bg.a < 0.5) bg = read(document.documentElement);
    const fg = document.body && C.parse(getComputedStyle(document.body).color);
    preflight.disabled = false;
    if (!bg || bg.a < 0.5) return false;
    return lchOf(bg).L < 0.35 && (!fg || lchOf(fg).L > 0.6);
  }

  function readableRules() {
    const out = [];
    const visit = (rules) => {
      for (const r of rules) {
        out.push(r);
        if (r.cssRules) visit(r.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try { visit(sheet.cssRules); } catch { /* cross-origin */ }
    }
    return out;
  }

  // Prefer the site's own dark mode: un-gate prefers-color-scheme rules, or
  // turn on a dark class/attribute the stylesheets already define.
  function tryNativeDark() {
    const rules = readableRules();
    const media = rules.filter((r) => r instanceof CSSMediaRule && /prefers-color-scheme\s*:\s*dark/.test(r.conditionText || r.media.mediaText));
    if (media.length) {
      const lightRules = rules.filter((r) => r instanceof CSSMediaRule && /prefers-color-scheme\s*:\s*light/.test(r.media.mediaText));
      for (const r of media) r.media.mediaText = r.media.mediaText.replace(/\(\s*prefers-color-scheme\s*:\s*dark\s*\)/g, '(min-width: 0px)');
      for (const r of lightRules) r.media.mediaText = r.media.mediaText.replace(/\(\s*prefers-color-scheme\s*:\s*light\s*\)/g, '(max-width: 0px)');
      if (pageLooksDark()) return { kind: 'media', count: media.length };
    }
    const selectors = rules.map((r) => r.selectorText || '').join('\n');
    // Any class with "dark" or "night" in its name that the stylesheets use,
    // most-used first, plus the common theme attributes.
    const counts = new Map();
    for (const m of selectors.matchAll(/\.([\w-]*(?:dark|night)[\w-]*)/gi)) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    const classes = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c]) => ['class', c]);
    const attrs = [['data-theme', 'dark'], ['data-bs-theme', 'dark'], ['data-color-mode', 'dark'], ['data-mode', 'dark'], ['data-color-scheme', 'dark']]
      .filter(([a]) => selectors.includes(`[${a}`));
    const candidates = [...classes, ...attrs];
    for (const [attr, value] of candidates) {
      for (const el of [document.documentElement, document.body]) {
        if (attr === 'class' && el.classList.contains(value)) continue;
        const prev = attr === 'class' ? null : el.getAttribute(attr);
        if (attr === 'class') el.classList.add(value); else el.setAttribute(attr, value);
        if (pageLooksDark()) return { kind: attr, value, on: el === document.body ? 'body' : 'html' };
        if (attr === 'class') el.classList.remove(value); else if (prev === null) el.removeAttribute(attr); else el.setAttribute(attr, prev);
      }
    }
    return null;
  }

  function reapplyNative(n) {
    if (n.kind === 'media') return !!tryNativeDark();
    const el = n.on === 'body' ? document.body : document.documentElement;
    if (n.kind === 'class') el.classList.add(n.value); else el.setAttribute(n.kind, n.value);
    return pageLooksDark();
  }

  // ---------------------------------------------------------------- Jev
  const jevAllowed = () =>
    !PRIVATE_HOST.test(host) && !document.querySelector('input[type=password]') && profile.jev !== false;

  async function jev(state, questions) {
    if (!jevAllowed()) return null;
    status.jev.calls++;
    const names = Object.keys(questions);
    log('jev:ask', { questions: names.length, kinds: [...new Set(names.map((n) => n.replace(/_?[ei]?\d+$/, '')))] });
    const res = await chrome.runtime.sendMessage({ type: 'jev', state, questions }).catch((e) => ({ ok: false, error: String(e.message || e) }));
    if (!res?.ok) {
      status.jev.lastError = res?.error || 'no response';
      status.jev.failedAt = Date.now();
      log('jev:error', { error: status.jev.lastError });
      return null;
    }
    status.jev.lastError = null;
    status.jev.lastMs = res.ms;
    log('jev:answer', { ms: res.ms, answers: summarizeAnswers(res.answers) });
    return res.answers;
  }

  // Compact form of Jev's answers for the log: "surface 0.95", "2.67".
  function summarizeAnswers(answers) {
    const out = {};
    for (const [name, a] of Object.entries(answers || {})) {
      if (a?.type === 'score') out[name] = +a.score.toFixed(2);
      else if (a?.type === 'boolean') out[name] = +a.probability.toFixed(2);
      else if (a?.type === 'refusal') out[name] = 'refusal';
      else {
        const c = choiceOf(a);
        out[name] = c ? `${c.choice} ${c.p ?? ''}`.trim() : null;
      }
    }
    return out;
  }

  function choiceOf(a, minP = 0) {
    if (!a || a.type === 'refusal') return null;
    let choice = a.choice;
    const p = a.probabilities || {};
    if (!choice && Object.keys(p).length) choice = Object.entries(p).sort((x, y) => y[1] - x[1])[0][0];
    if (!choice) return null;
    return (p[choice] ?? 1) >= minP ? { choice, p: p[choice] ?? null } : null;
  }

  // What is on screen, by original color: sample a grid and credit each
  // point to the nearest themed ancestor's original background.
  function paletteSummary() {
    const surfaces = new Map(), brand = new Map();
    let points = 0;
    for (let y = 0.05; y < 1; y += 0.1) {
      for (let x = 0.05; x < 1; x += 0.1) {
        const el = document.elementFromPoint(x * innerWidth, y * innerHeight);
        if (!el) continue;
        points++;
        for (let p = el; p; p = p.parentElement) {
          const info = roleOf.get(p);
          if (!info) continue;
          const m = info.lch.C >= 0.045 ? brand : surfaces;
          const hex = C.hex(toRgb(info.lch));
          m.set(hex, (m.get(hex) || 0) + 1);
          break;
        }
      }
    }
    const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([hex, n]) => {
      const l = lchOf(C.parse(hex));
      return { hex, screenShare: +(n / Math.max(1, points)).toFixed(2), L: +l.L.toFixed(2), C: +l.C.toFixed(3), H: Math.round(l.H) };
    });
    const stats = liveStats();
    return {
      brandColors: top(brand),
      tintedSurfaces: top(surfaces),
      elementCount: stats.elements,
      imageCount: Object.values(stats.images).reduce((a, b) => a + b, 0),
    };
  }

  const ROLE_CRITERIA = {
    surface: 'A background region (page body, section, card, sidebar, navigation bar, or a pale tinted note, callout or highlight box) that should become a dark surface, keeping only a hint of its hue.',
    accent: 'A brand-colored control or highlight (button, badge, tag, banner strip, active tab) that should stay recognizably colored on a dark page.',
    keep: 'Content where the exact color carries meaning (chart, color swatch, status light, product color, flag) and must not change.',
  };
  const IMAGE_CRITERIA = {
    keep: 'Photo, illustration or full-color artwork that already looks fine on a dark page.',
    dim: 'Bright colorful image (photo, screenshot or illustration with real color, meanSaturation well above 0) that should be slightly dimmed so it does not glare.',
    backdrop: 'Product or object photo on a plain white or light-grey studio backdrop (edgeWhiteFraction near 1): the backdrop would sit as a glaring white box on a dark page, so darken the whole image into a soft tile.',
    invert: 'Colorless or nearly colorless line art (meanSaturation near 0, few colorBuckets): a dark logo, icon or text image on a transparent background, or a black-on-white diagram, chart, sketch or scan. A dimmed white box would still glare, so invert its lightness.',
  };

  // Render SVG markup from a blob URL (same-origin, so the canvas stays
  // readable) and compute the same statistics the worker computes for rasters.
  async function sampleSvg(markup) {
    const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const w0 = img.naturalWidth || 64, h0 = img.naturalHeight || 64;
      const scale = Math.min(1, 64 / Math.max(w0, h0));
      const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, h);
      return { width: w0, height: h0, mime: 'image/svg+xml', ...pixelStats(ctx.getImageData(0, 0, w, h).data, w * h, w) };
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function analyzePixels(entries) {
    const need = entries.filter((e) => e.px === undefined);
    if (!need.length) return;
    const results = await chrome.runtime.sendMessage({ type: 'analyzeImages', urls: need.map((e) => e.url) }).catch(() => null);
    await Promise.all(need.map(async (e, i) => {
      const r = results?.[i] ?? null;
      e.px = r?.svg ? await sampleSvg(r.svg) : r;
    }));
    for (const e of need) {
      const t = priorTreatment(e.meta, e.px);
      for (const el of e.els) if (el.isConnected) applyImage(el, t);
    }
    drain();
  }

  // First visit: palette, roles and images in one request. Later visits only
  // ask about elements and images Jev hasn't seen.
  async function decide({ includePage }) {
    const roleEntries = [...pendingRoles.entries()].slice(0, 36);
    await analyzePixels([...pendingImages.values()].slice(0, 120));
    const imageEntries = [...pendingImages.entries()].slice(0, includePage ? 24 : 28);
    if (!includePage && !roleEntries.length && !imageEntries.length) return false;

    const state = {
      task: 'A light-themed website is being converted to a dark theme by a browser extension. Judge how to treat its colors and images.',
      page: includePage ? paletteSummary() : undefined,
      elements: Object.fromEntries(roleEntries.map(([, d], i) => [`e${i}`, d])),
      images: Object.fromEntries(imageEntries.map(([, e], i) => [`i${i}`, { ...e.meta, pixels: e.px }])),
    };
    const questions = {};
    if (includePage) {
      questions.surface_tone = {
        type: 'choice',
        instructions: 'Which tone should the dark surfaces of this site use, given state.page.brandColors?',
        criteria: {
          neutral: 'Plain neutral dark gray; best for content-heavy sites or when brand colors are varied.',
          brand: 'Dark surfaces faintly tinted toward the single dominant brand hue; best when one strong color defines the site.',
          warm: 'Faintly warm dark gray; suits sites whose palette is mostly warm (reds, oranges, browns, creams).',
          cool: 'Faintly cool dark blue-gray; suits sites whose palette is mostly cool (blues, teals).',
        },
      };
      questions.accent_policy = {
        type: 'choice',
        instructions: 'How should brand-colored buttons, badges and banners be treated in dark mode?',
        criteria: {
          keep: 'Keep them vivid; the brand color is part of the identity and the elements are small.',
          mute: 'Soften them slightly; there are many saturated elements that would glare on a dark page.',
        },
      };
      questions.depth = {
        type: 'score',
        instructions: 'How dark should the base surface be for this site?',
        criteria: ['Very dark, near black (dense text, reading sites)', 'Standard dark gray', 'Soft dim gray (image-heavy or colorful sites)'],
      };
    }
    roleEntries.forEach((_, i) => {
      questions[`role_e${i}`] = { type: 'choice', instructions: `How should element e${i} in state.elements be treated in dark mode?`, criteria: ROLE_CRITERIA };
    });
    imageEntries.forEach((_, i) => {
      questions[`image_i${i}`] = { type: 'choice', instructions: `How should image i${i} in state.images be treated in dark mode?`, criteria: IMAGE_CRITERIA };
    });

    const answers = await jev(state, questions);
    if (!answers) return false;
    let changed = false;

    if (includePage) {
      const tone = choiceOf(answers.surface_tone)?.choice;
      const accent = choiceOf(answers.accent_policy)?.choice;
      const depth = answers.depth?.type === 'score' ? answers.depth.score : null;
      const next = { ...theme };
      if (tone) {
        next.tone = tone;
        const dominant = state.page.brandColors[0];
        const t = tone === 'brand' && dominant ? { H: dominant.H, C: 0.022 } : TONES[tone] || TONES.neutral;
        next.surfaceHue = t.H;
        next.surfaceChroma = t.C;
      }
      if (accent === 'keep' || accent === 'mute') next.accent = accent;
      if (depth != null) next.surfaceL = DEPTHS[Math.round(C.clamp(depth, 0, 2))];
      changed = JSON.stringify(next) !== JSON.stringify(theme);
      theme = next;
      profile.theme = { ...theme };
      profile.jevAt = Date.now();
    }

    roleEntries.forEach(([sig], i) => {
      const c = choiceOf(answers[`role_e${i}`], 0.4);
      pendingRoles.delete(sig);
      if (!c) return;
      status.jev.decisions++;
      if (profile.roles[sig]?.role !== c.choice) changed = true;
      profile.roles[sig] = { role: c.choice, p: c.p, at: Date.now() };
    });
    imageEntries.forEach(([key, entry], i) => {
      const c = choiceOf(answers[`image_i${i}`], 0.4);
      pendingImages.delete(key);
      const treatment = c?.choice || priorTreatment(entry.meta, entry.px);
      if (c) status.jev.decisions++;
      profile.images[key] = { treatment, p: c?.p ?? null, source: c ? 'jev' : 'prior', at: Date.now() };
      for (const el of entry.els) if (el.isConnected) applyImage(el, treatment);
    });
    drain();
    saveProfile();
    return changed;
  }

  // ---------------------------------------------------------------- verify & adapt
  function coverage() {
    const vw = innerWidth, vh = innerHeight;
    let total = 0, bright = 0, media = 0;
    for (let y = 0.04; y < 1; y += 0.08) {
      for (let x = 0.04; x < 1; x += 0.08) {
        const el = document.elementFromPoint(x * vw, y * vh);
        if (!el) continue;
        total++;
        if (MEDIA.has(el.tagName)) { media++; continue; }
        const b = effBg.get(el) || parentBg(el);
        if (C.luminance(b) > 0.4) bright++;
      }
    }
    return { brightAreaShare: +(bright / Math.max(1, total)).toFixed(2), mediaAreaShare: +(media / Math.max(1, total)).toFixed(2) };
  }

  const ADJUSTMENTS = {
    none: 'Leave the theme as it is.',
    raise_contrast: 'Text is hard to read; raise text contrast.',
    darker: 'Surfaces are too light or gray; make them darker.',
    lighter: 'Surfaces are too dark or harsh; make them a little lighter.',
    mute_accents: 'Colored buttons and banners glare; mute them.',
    restore_accents: 'Brand colors look washed out; keep them vivid.',
    dim_images: 'Images are too bright against the dark page; dim them more.',
  };

  function applyAdjustment(name) {
    const t = { ...theme };
    if (name === 'raise_contrast') { t.minContrast = Math.min(7, t.minContrast + 1.25); t.textL = Math.min(0.97, t.textL + 0.03); }
    else if (name === 'darker') t.surfaceL = Math.max(0.1, t.surfaceL - 0.04);
    else if (name === 'lighter') t.surfaceL = Math.min(0.26, t.surfaceL + 0.04);
    else if (name === 'mute_accents') t.accent = 'mute';
    else if (name === 'restore_accents') t.accent = 'keep';
    else if (name === 'dim_images') t.imageDim = Math.max(0.65, t.imageDim - 0.1);
    else return false;
    if (JSON.stringify(t) === JSON.stringify(theme)) {
      log('adjust:at-limit', { name });
      return false;
    }
    log('adjust', { name, from: pickTheme(theme), to: pickTheme(t) });
    theme = t;
    profile.theme = { ...t };
    status.adjustments.push(name);
    profile.history = [...(profile.history || []).slice(-19), { at: Date.now(), adjustment: name }];
    saveNow();
    return true;
  }

  const pickTheme = (t) => ({ surfaceL: +t.surfaceL.toFixed(3), accent: t.accent, minContrast: t.minContrast, imageDim: +t.imageDim.toFixed(2) });

  async function verify(feedback = null) {
    const stats = liveStats();
    const state = {
      task: 'A browser extension converted a light website to dark mode. Judge the result from these measurements and pick one correction.',
      result: {
        ...coverage(),
        textElements: stats.text,
        lowContrastTextShare: +(stats.lowContrast / Math.max(1, stats.text)).toFixed(3),
        accentSurfaces: stats.accents,
        images: stats.images,
        theme: { surfaceLightness: theme.surfaceL, tone: theme.tone, accentPolicy: theme.accent, minContrast: theme.minContrast, imageBrightness: theme.imageDim },
        previousAdjustments: (profile.history || []).slice(-5).map((h) => h.adjustment || h.feedback),
      },
      userFeedback: feedback,
    };
    const answers = await jev(state, {
      quality: {
        type: 'score',
        instructions: 'How good is this dark theme?',
        criteria: ['Broken: large bright areas remain or text is unreadable', 'Poor: noticeable bright patches or weak contrast', 'Acceptable', 'Good: consistent dark surfaces and readable text'],
      },
      adjust: {
        type: 'choice',
        instructions: feedback
          ? 'The user reported a problem in state.userFeedback. Which single correction best addresses it?'
          : 'Which single correction would most improve this theme? Choose none unless the measurements show a problem.',
        criteria: feedback ? Object.fromEntries(Object.entries(ADJUSTMENTS).filter(([k]) => k !== 'none')) : ADJUSTMENTS,
      },
    });
    if (!answers) return null;
    status.quality = answers.quality?.score ?? null;
    const adj = choiceOf(answers.adjust, feedback ? 0 : 0.5)?.choice;
    log('verify', { feedback, quality: status.quality, adjust: adj ?? null, measured: state.result });
    return adj && adj !== 'none' ? adj : null;
  }

  const FEEDBACK_FALLBACK = { too_dark: 'lighter', too_bright: 'darker', hard_to_read: 'raise_contrast', colors_wrong: 'restore_accents', images_wrong: 'dim_images' };
  const FEEDBACK_TEXT = {
    too_dark: 'The page feels too dark.',
    too_bright: 'Parts of the page are still too bright.',
    hard_to_read: 'Text is hard to read.',
    colors_wrong: 'The colors look wrong or off-brand.',
    images_wrong: 'Images look wrong.',
  };

  async function onFeedback(kind) {
    profile.history = [...(profile.history || []).slice(-19), { at: Date.now(), feedback: kind }];
    const fromJev = await verify(FEEDBACK_TEXT[kind]);
    const adj = fromJev || FEEDBACK_FALLBACK[kind];
    log('feedback', { kind, adjustment: adj, source: fromJev ? 'jev' : 'fallback' });
    if (applyAdjustment(adj)) {
      await rethemeAll();
      return adj;
    }
    return null;
  }

  let jevTimer = 0;
  function scheduleJev() {
    if (!enabled || (!pendingRoles.size && !pendingImages.size)) return;
    if (Date.now() - (status.jev.failedAt || 0) < 60000) return;
    clearTimeout(jevTimer);
    jevTimer = setTimeout(async () => {
      if (await decide({ includePage: false })) await rethemeAll();
    }, 1500);
  }

  async function adaptLoop() {
    const fresh = !profile.theme || Date.now() - (profile.jevAt || 0) > 7 * 864e5;
    if (await decide({ includePage: fresh })) await rethemeAll();
    if (!fresh) return;
    for (let round = 0; round < 2; round++) {
      const adj = await verify();
      if (!adj || !applyAdjustment(adj)) break;
      await rethemeAll();
    }
  }

  // ---------------------------------------------------------------- element picker
  function pick() {
    return new Promise((resolve) => {
      const hl = document.createElement('div');
      hl.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;outline:2px solid #ff4fa3;background:rgba(255,79,163,.12);transition:all .05s';
      document.documentElement.appendChild(hl);
      const move = (e) => {
        const r = e.target.getBoundingClientRect();
        Object.assign(hl.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      };
      const click = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        cleanup();
        resolve(await cycleElement(e.target));
      };
      const key = (e) => { if (e.key === 'Escape') { cleanup(); resolve(null); } };
      function cleanup() {
        hl.remove();
        removeEventListener('mousemove', move, true);
        removeEventListener('click', click, true);
        removeEventListener('keydown', key, true);
      }
      addEventListener('mousemove', move, true);
      addEventListener('click', click, true);
      addEventListener('keydown', key, true);
    });
  }

  async function cycleElement(target) {
    const img = target.closest('img') || (MEDIA.has(target.tagName) ? target : null);
    if (img?.tagName === 'IMG') {
      const k = 'img:' + imageKey(img.currentSrc || img.src);
      const order = ['keep', 'dim', 'backdrop', 'invert'];
      const cur = profile.overrides[k] || profile.images[k.slice(4)]?.treatment || 'keep';
      profile.overrides[k] = order[(order.indexOf(cur) + 1) % order.length];
      await saveNow();
      await rethemeAll();
      return { image: profile.overrides[k] };
    }
    for (let el = target; el; el = el.parentElement) {
      const info = roleOf.get(el);
      if (!info) continue;
      const order = ['surface', 'accent', 'keep'];
      profile.overrides[info.sig] = order[(order.indexOf(info.role) + 1) % order.length];
      await saveNow();
      await rethemeAll();
      return { element: profile.overrides[info.sig] };
    }
    return null;
  }

  // ---------------------------------------------------------------- lifecycle
  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    (async () => {
      if (msg.type === 'diagnostics') {
        return {
          version: chrome.runtime.getManifest().version,
          host,
          userAgent: navigator.userAgent,
          viewport: [innerWidth, innerHeight],
          status: { ...status },
          enabled,
          theme,
          stats: liveStats(),
          jevAllowed: profile ? jevAllowed() : null,
          profile: profile && {
            mode: profile.mode || 'auto',
            native: profile.native || null,
            jevAt: profile.jevAt || null,
            roles: Object.values(profile.roles || {}).reduce((m, r) => ((m[r.role] = (m[r.role] || 0) + 1), m), {}),
            images: Object.values(profile.images || {}).reduce((m, r) => ((m[r.treatment] = (m[r.treatment] || 0) + 1), m), {}),
            overrides: Object.keys(profile.overrides || {}).length,
            history: profile.history || [],
          },
          pending: { roles: pendingRoles.size, images: pendingImages.size },
          events,
        };
      }
      if (msg.type === 'status') return { ...status, host, enabled, theme, siteMode: profile?.mode, stats: liveStats(), jevAllowed: profile ? jevAllowed() : null };
      if (msg.type === 'setMode') {
        profile.mode = msg.mode;
        await saveNow();
        location.reload();
        return true;
      }
      if (msg.type === 'feedback') return { adjustment: await onFeedback(msg.kind) };
      if (msg.type === 'pick') return pick();
      if (msg.type === 'reset') {
        await chrome.storage.local.remove(KEY);
        location.reload();
        return true;
      }
      if (msg.type === 'reverify') {
        const adj = await verify();
        if (adj && applyAdjustment(adj)) await rethemeAll();
        return { adjustment: adj, quality: status.quality };
      }
      return null;
    })().then(reply);
    return true;
  });

  async function start() {
    profile = await loadProfile();
    if (profile.mode === 'off') {
      status.mode = 'off';
      return unthemeAll();
    }
    if (profile.theme) theme = { ...DEFAULT_THEME, ...profile.theme };
    if (document.readyState === 'loading') await new Promise((r) => addEventListener('DOMContentLoaded', r, { once: true }));

    if (profile.mode !== 'on') {
      if (profile.native && reapplyNative(profile.native)) {
        status.mode = 'native';
        status.native = profile.native;
        return preflight.remove();
      }
      if (pageLooksDark()) {
        status.mode = 'already-dark';
        return preflight.remove();
      }
      const native = tryNativeDark();
      if (native) {
        log('native', native);
        profile.native = native;
        saveProfile();
        status.mode = 'native';
        status.native = native;
        return preflight.remove();
      }
    }

    enabled = true;
    status.mode = 'themed';
    log('start', { mode: 'themed', siteMode: profile.mode || 'auto', cached: { roles: Object.keys(profile.roles || {}).length, images: Object.keys(profile.images || {}).length }, theme: pickTheme(theme) });
    base.textContent = `:root{color-scheme:dark!important}::selection{background:rgba(120,150,255,.35)}`;
    (document.head || document.documentElement).append(base, pseudoSheet);
    observe();
    const w0 = performance.now();
    await walk(document.documentElement, 60);
    log('walk', { ms: Math.round(performance.now() - w0), ...liveStats() });
    preflight.remove();
    document.documentElement.setAttribute('data-dusk-ready', '');
    await adaptLoop();
    scheduleJev();
    document.documentElement.setAttribute('data-dusk-adapted', String(status.jev.lastError === null && status.jev.calls > 0));
  }

  start().catch((err) => {
    status.mode = 'error';
    status.error = String(err);
    preflight.remove();
  });
})();
