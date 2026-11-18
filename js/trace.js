// Auto-trace: tap on an object (or a contour-gauge outline on paper) and get its outline.
// Works on a downscaled grayscale copy: blur -> Otsu threshold -> flood fill from the tap ->
// fill holes -> marching-squares boundary -> Douglas-Peucker simplify.

export function grayFromImage(img, maxDim = 900) {
  const s = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return { g: blur(g, w, h), w, h, scale: s };
}

function blur(g, w, h) {
  const o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) { s += g[yy * w + xx]; n++; }
    }
    o[y * w + x] = s / n;
  }
  return o;
}

export function otsu(g) {
  const hist = new Float64Array(256);
  for (const v of g) hist[Math.max(0, Math.min(255, v | 0))]++;
  const total = g.length;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; t = i; }
  }
  return t;
}

/** Returns {mask, area} for the region connected to (sx,sy) on the same side of the threshold. */
export function regionFrom(gray, sx, sy, sensitivity = 0) {
  const { g, w, h } = gray;
  const T = otsu(g) + sensitivity;
  sx = Math.max(0, Math.min(w - 1, Math.round(sx)));
  sy = Math.max(0, Math.min(h - 1, Math.round(sy)));
  const dark = g[sy * w + sx] <= T;
  const inside = (i) => (g[i] <= T) === dark;
  const mask = new Uint8Array(w * h);
  const stack = [sy * w + sx];
  mask[stack[0]] = 1;
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i / w) | 0;
    if (x > 0 && !mask[i - 1] && inside(i - 1)) { mask[i - 1] = 1; stack.push(i - 1); }
    if (x < w - 1 && !mask[i + 1] && inside(i + 1)) { mask[i + 1] = 1; stack.push(i + 1); }
    if (y > 0 && !mask[i - w] && inside(i - w)) { mask[i - w] = 1; stack.push(i - w); }
    if (y < h - 1 && !mask[i + w] && inside(i + w)) { mask[i + w] = 1; stack.push(i + w); }
  }
  // Fill holes: anything not reachable from the border through non-mask pixels becomes mask
  const outside = new Uint8Array(w * h);
  const st = [];
  const pushIf = (i) => { if (!mask[i] && !outside[i]) { outside[i] = 1; st.push(i); } };
  for (let x = 0; x < w; x++) { pushIf(x); pushIf((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { pushIf(y * w); pushIf(y * w + w - 1); }
  while (st.length) {
    const i = st.pop();
    const x = i % w, y = (i / w) | 0;
    if (x > 0) pushIf(i - 1);
    if (x < w - 1) pushIf(i + 1);
    if (y > 0) pushIf(i - w);
    if (y < h - 1) pushIf(i + w);
  }
  let area = 0;
  for (let i = 0; i < w * h; i++) { if (!outside[i]) { mask[i] = 1; area++; } }
  return { mask, area, frac: area / (w * h) };
}

/** Marching-squares outer boundary of a single filled blob. Returns corner points. */
export function traceBoundary(mask, w, h) {
  const get = (x, y) => (x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x]) ? 1 : 0;
  let start = -1;
  for (let i = 0; i < w * h; i++) if (mask[i]) { start = i; break; }
  if (start < 0) return [];
  const sx = start % w, sy = (start / w) | 0;
  let x = sx, y = sy, pdx = 0, pdy = 0;
  const pts = [];
  let guard = 0;
  do {
    const s = get(x - 1, y - 1) + 2 * get(x, y - 1) + 4 * get(x - 1, y) + 8 * get(x, y);
    let dx = 0, dy = 0;
    switch (s) {
      case 1: case 5: case 13: dy = -1; break;
      case 2: case 3: case 7: dx = 1; break;
      case 4: case 12: case 14: dx = -1; break;
      case 8: case 10: case 11: dy = 1; break;
      case 6: if (pdx === 0 && pdy === -1) dx = -1; else dx = 1; break;
      case 9: if (pdx === 1 && pdy === 0) dy = -1; else dy = 1; break;
      default: return pts;
    }
    if (dx !== pdx || dy !== pdy) pts.push([x, y]);
    x += dx; y += dy; pdx = dx; pdy = dy;
    if (++guard > 4 * w * h) break;
  } while (x !== sx || y !== sy);
  return pts;
}

function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const dist = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy);
    if (!l) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / l;
  };
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop();
    let m = -1, md = 0;
    for (let i = a + 1; i < b; i++) { const d = dist(pts[i], pts[a], pts[b]); if (d > md) { md = d; m = i; } }
    if (md > eps && m > 0) { keep[m] = 1; st.push([a, m], [m, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Simplify a closed loop to at most maxPts points. */
export function simplifyClosed(pts, maxPts = 70) {
  if (pts.length < 4) return pts;
  // split the loop at the point farthest from pts[0] so RDP works on two open chains
  let far = 0, fd = 0;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > fd) { fd = d; far = i; }
  }
  let eps = 1.0, res;
  for (let k = 0; k < 20; k++) {
    const a = rdp(pts.slice(0, far + 1), eps);
    const b = rdp(pts.slice(far).concat([pts[0]]), eps);
    res = a.slice(0, -1).concat(b.slice(0, -1));
    if (res.length <= maxPts) break;
    eps *= 1.3;
  }
  return res;
}

/** Mark gently-turning vertices as smooth so curves stay curves. */
export function autoSmooth(pts, angleDeg = 28) {
  const n = pts.length;
  return pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const u = [p.x - a.x, p.y - a.y], v = [b.x - p.x, b.y - p.y];
    const ang = Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])) * 180 / Math.PI;
    return { ...p, smooth: ang < angleDeg };
  });
}
