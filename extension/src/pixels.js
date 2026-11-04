// Image statistics shared by the worker (rasters) and the content script
// (SVG). Only these numbers are ever shown to Jev.
// With `width`, also measures the outer ring of pixels, which tells a photo
// on a white studio backdrop apart from one that fills its frame.
globalThis.pixelStats = function pixelStats(data, total, width = 0) {
  let n = 0, transparent = 0, sumL = 0, sumSat = 0, white = 0, black = 0;
  let edge = 0, edgeWhite = 0, edgeClear = 0;
  const height = width ? total / width : 0;
  const buckets = new Set();
  for (let i = 0; i < data.length; i += 4) {
    const px = i / 4, x = width ? px % width : 0, y = width ? (px / width) | 0 : 0;
    const onEdge = width && (x < 2 || y < 2 || x >= width - 2 || y >= height - 2);
    if (onEdge) edge++;
    if (data[i + 3] < 26) { transparent++; if (onEdge) edgeClear++; continue; }
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    sumL += l;
    sumSat += max - min;
    if (l > 0.92) white++;
    if (onEdge && l > 0.88 && max - min < 0.08) edgeWhite++;
    if (l < 0.12) black++;
    buckets.add(((r * 7) | 0) * 64 + ((g * 7) | 0) * 8 + ((b * 7) | 0));
    n++;
  }
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return {
    transparentFraction: r3(transparent / total),
    meanLightness: n ? r3(sumL / n) : 0,
    meanSaturation: n ? r3(sumSat / n) : 0,
    nearWhiteFraction: n ? r3(white / n) : 0,
    nearBlackFraction: n ? r3(black / n) : 0,
    colorBuckets: buckets.size,
    ...(edge && { edgeWhiteFraction: r3(edgeWhite / edge), edgeTransparentFraction: r3(edgeClear / edge) }),
  };
};
