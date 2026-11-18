// FitForge geometry: turns control points (+ radius-gauge corners and arc edges)
// into a dense outline in millimeters, then into a printable solid via Manifold.

const TAU = Math.PI * 2;

function sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
function mul(a, s) { return [a[0] * s, a[1] * s]; }
function len(a) { return Math.hypot(a[0], a[1]); }
function norm(a) { const l = len(a) || 1; return [a[0] / l, a[1] / l]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }

// Normalize an angle difference into (-PI, PI]
function wrap(a) {
  while (a <= -Math.PI) a += TAU;
  while (a > Math.PI) a -= TAU;
  return a;
}

export function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

function arcPoints(c, r, a0, sweep, includeStart, includeEnd) {
  const n = Math.max(4, Math.min(96, Math.ceil(Math.abs(sweep) * r / 0.25)));
  const out = [];
  for (let k = includeStart ? 0 : 1; k <= (includeEnd ? n : n - 1); k++) {
    const a = a0 + sweep * (k / n);
    out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  }
  return out;
}

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  const f = (i) => 0.5 * ((2 * p1[i]) + (-p0[i] + p2[i]) * t +
    (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 +
    (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3);
  return [f(0), f(1)];
}

/**
 * Build the outline in mm (Y up).
 * pts: [{x, y, r?, smooth?, arc?: {R, dir}}] in image pixels (Y down).
 *   r      – corner radius in mm (radius gauge on a corner)
 *   smooth – pass a smooth curve through this point
 *   arc    – the edge from this point to the next is an arc of radius R mm,
 *            dir = +1 bulges outward (convex), -1 curves inward (concave)
 * Returns { poly: [[x,y],...] CCW, info: {cornerR[], arcR[]} }
 */
export function buildOutline(pts, mmPerPx) {
  const n = pts.length;
  if (n < 3) return { poly: [], effR: [] };
  let P = pts.map(p => [p.x * mmPerPx, -p.y * mmPerPx]);
  const sgn = signedArea(P) >= 0 ? 1 : -1;
  const effR = new Array(n).fill(0);

  const isArc = (i) => pts[i].arc && pts[i].arc.R > 0;
  const curvedEdge = (i) => isArc(i) || pts[i].smooth || pts[(i + 1) % n].smooth;

  // Corner fillets (only between two straight edges)
  const fillet = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const r = pts[i].r || 0;
    if (r <= 0 || pts[i].smooth) continue;
    const ip = (i - 1 + n) % n, inx = (i + 1) % n;
    if (curvedEdge(ip) || curvedEdge(i)) continue;
    const p = P[i], a = P[ip], b = P[inx];
    const la = len(sub(a, p)), lb = len(sub(b, p));
    const u = norm(sub(a, p)), v = norm(sub(b, p));
    const th = Math.acos(Math.max(-1, Math.min(1, dot(u, v))));
    if (th < 0.02 || th > Math.PI - 0.02) continue;
    let t = r / Math.tan(th / 2);
    const maxT = 0.49 * Math.min(la, lb) * (pts[ip].r || pts[inx].r ? 1 : 1.9);
    if (t > maxT) t = maxT;
    const rr = t * Math.tan(th / 2);
    effR[i] = rr;
    const w = norm(add(u, v));
    const c = add(p, mul(w, rr / Math.sin(th / 2)));
    const t1 = add(p, mul(u, t)), t2 = add(p, mul(v, t));
    const a1 = Math.atan2(t1[1] - c[1], t1[0] - c[0]);
    const a2 = Math.atan2(t2[1] - c[1], t2[0] - c[0]);
    fillet[i] = arcPoints(c, rr, a1, wrap(a2 - a1), true, true);
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    const inx = (i + 1) % n;
    if (fillet[i]) out.push(...fillet[i]); else out.push(P[i]);
    const A = P[i], B = P[inx];
    if (isArc(i)) {
      const L = len(sub(B, A));
      if (L < 1e-6) continue;
      const R = Math.max(pts[i].arc.R, L / 2 + 1e-6);
      const dir = pts[i].arc.dir >= 0 ? 1 : -1;
      const d = sub(B, A);
      const outward = mul([d[1], -d[0]], sgn / L); // outward normal
      const bulge = mul(outward, dir);
      const M = mul(add(A, B), 0.5);
      const h = Math.sqrt(Math.max(0, R * R - L * L / 4));
      const c = sub(M, mul(bulge, h));
      const a0 = Math.atan2(A[1] - c[1], A[0] - c[0]);
      const a1 = Math.atan2(B[1] - c[1], B[0] - c[0]);
      let sw = wrap(a1 - a0);
      const apex = add(M, mul(bulge, R - h));
      const am = Math.atan2(apex[1] - c[1], apex[0] - c[0]);
      if (Math.abs(wrap(a0 + sw / 2 - am)) > 0.01) sw = sw - Math.sign(sw) * TAU;
      out.push(...arcPoints(c, R, a0, sw, false, false));
    } else if (pts[i].smooth || pts[inx].smooth) {
      const p0 = P[(i - 1 + n) % n], p3 = P[(i + 2) % n];
      const q0 = pts[i].smooth ? p0 : sub(mul(A, 2), B);
      const q3 = pts[inx].smooth ? p3 : sub(mul(B, 2), A);
      const L = len(sub(B, A));
      const steps = Math.max(4, Math.min(40, Math.ceil(L / 0.6)));
      for (let k = 1; k < steps; k++) out.push(catmull(q0, A, B, q3, k / steps));
    }
  }

  // Remove near-duplicates
  const poly = [];
  for (const q of out) {
    const last = poly[poly.length - 1];
    if (!last || len(sub(q, last)) > 1e-4) poly.push(q);
  }
  if (poly.length > 2 && len(sub(poly[0], poly[poly.length - 1])) < 1e-4) poly.pop();
  if (signedArea(poly) < 0) poly.reverse();
  return { poly, effR };
}

export function bbox(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) {
    if (x < x0) x0 = x; if (y < y0) y0 = y;
    if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/**
 * params: {
 *   mode: 'solid' | 'holder',
 *   thickness, clearance,           // solid
 *   floor, depth, wall, outer: 'follow'|'rect', outerR,  // holder
 *   slice: boolean                  // thin test-fit slice
 * }
 */
export function buildSolid(wasm, poly, params) {
  const { CrossSection } = wasm;
  if (poly.length < 3) return null;
  const SEG = 64;
  const shape = new CrossSection([poly], 'Positive');
  const clr = +params.clearance || 0;
  let solid;
  if (params.mode === 'holder') {
    const pocket = shape.offset(clr, 'Round', 2, SEG);
    let outer;
    if (params.outer === 'rect') {
      const b = pocket.bounds();
      const wall = Math.max(0.4, +params.wall || 0);
      const w = b.max[0] - b.min[0] + 2 * wall, h = b.max[1] - b.min[1] + 2 * wall;
      const r = Math.max(0, Math.min(+params.outerR || 0, w / 2 - 0.01, h / 2 - 0.01));
      let rect = CrossSection.square([w - 2 * r, h - 2 * r]).translate([b.min[0] - wall + r, b.min[1] - wall + r]);
      outer = r > 0 ? rect.offset(r, 'Round', 2, SEG) : rect;
    } else {
      outer = pocket.offset(Math.max(0.4, +params.wall || 0), 'Round', 2, SEG);
    }
    if (params.slice) {
      solid = outer.subtract(pocket).extrude(2);
    } else {
      const floor = Math.max(0, +params.floor || 0), depth = Math.max(0.2, +params.depth || 0);
      solid = outer.extrude(floor + depth).subtract(pocket.extrude(depth + 1).translate([0, 0, floor]));
    }
  } else {
    const part = clr !== 0 ? shape.offset(-clr, 'Round', 2, SEG) : shape;
    const t = Math.max(0.2, +params.thickness || 0);
    solid = part.extrude(params.slice ? Math.min(1.6, t) : t);
  }
  // Center on XY origin, sit on Z=0
  const bb = solid.boundingBox();
  solid = solid.translate([-(bb.min[0] + bb.max[0]) / 2, -(bb.min[1] + bb.max[1]) / 2, -bb.min[2]]);
  const mesh = solid.getMesh();
  // Weld vertices by position (Manifold can split verts along boolean seams)
  const np = mesh.numProp;
  const nv = mesh.vertProperties.length / np;
  const key = new Map(), remap = new Uint32Array(nv), pos = [];
  for (let i = 0; i < nv; i++) {
    const x = mesh.vertProperties[i * np], y = mesh.vertProperties[i * np + 1], z = mesh.vertProperties[i * np + 2];
    const k = Math.round(x * 1e4) + ',' + Math.round(y * 1e4) + ',' + Math.round(z * 1e4);
    let id = key.get(k);
    if (id === undefined) { id = pos.length / 3; key.set(k, id); pos.push(x, y, z); }
    remap[i] = id;
  }
  const tri = [];
  for (let t = 0; t < mesh.triVerts.length; t += 3) {
    const a = remap[mesh.triVerts[t]], b = remap[mesh.triVerts[t + 1]], c = remap[mesh.triVerts[t + 2]];
    if (a !== b && b !== c && a !== c) tri.push(a, b, c);
  }
  const positions = new Float32Array(pos);
  const out = {
    positions,
    indices: new Uint32Array(tri),
    size: [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]],
    volume: solid.volume(),
  };
  return out;
}
