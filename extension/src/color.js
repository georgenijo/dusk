// Color math shared by the content script. Everything works in OKLCH so that
// lightness changes keep hue and perceived saturation intact.
(() => {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  let probe = null;
  function parse(str) {
    if (!str || str === 'transparent' || str === 'none') return null;
    let m = str.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
    if (m) {
      let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a };
    }
    m = str.match(/^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.]+%?))?\)$/);
    if (m) {
      let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return { r: +m[1], g: +m[2], b: +m[3], a };
    }
    // Anything else (oklch(), lab(), named colors): let the browser normalize.
    probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = '#000';
    probe.fillStyle = str;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
    return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
  }

  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const fromLinear = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

  function toOklch({ r, g, b, a = 1 }) {
    const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    const C = Math.hypot(A, B);
    const H = C < 1e-4 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
    return { L, C, H, a };
  }

  function oklchToRgbRaw(L, C, H) {
    const h = (H * Math.PI) / 180;
    const A = C * Math.cos(h), B = C * Math.sin(h);
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    return [
      fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    ];
  }

  // Reduce chroma until the color fits in sRGB, so hue never shifts.
  function fromOklch({ L, C, H, a = 1 }) {
    L = clamp(L, 0, 1);
    let lo = 0, hi = C, rgb = oklchToRgbRaw(L, C, H);
    const inGamut = (c) => c.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
    if (!inGamut(rgb)) {
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) / 2;
        if (inGamut(oklchToRgbRaw(L, mid, H))) lo = mid; else hi = mid;
      }
      rgb = oklchToRgbRaw(L, lo, H);
    }
    const [r, g, b] = rgb.map((v) => clamp(v, 0, 1));
    return { r, g, b, a };
  }

  function format({ r, g, b, a = 1 }) {
    const R = Math.round(r * 255), G = Math.round(g * 255), B = Math.round(b * 255);
    return a >= 0.999 ? `rgb(${R}, ${G}, ${B})` : `rgba(${R}, ${G}, ${B}, ${+a.toFixed(3)})`;
  }

  function hex({ r, g, b }) {
    return '#' + [r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  }

  function luminance({ r, g, b }) {
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  }

  function contrast(c1, c2) {
    const a = luminance(c1), b = luminance(c2);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  // Composite a translucent color over an opaque one.
  function over(top, bottom) {
    const a = top.a ?? 1;
    return {
      r: top.r * a + bottom.r * (1 - a),
      g: top.g * a + bottom.g * (1 - a),
      b: top.b * a + bottom.b * (1 - a),
      a: 1,
    };
  }

  globalThis.DuskColor = { clamp, parse, toOklch, fromOklch, format, hex, luminance, contrast, over };
})();
