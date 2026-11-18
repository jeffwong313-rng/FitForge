import { buildOutline, bbox, buildSolid } from './geometry.js';
import { grayFromImage, regionFrom, traceBoundary, simplifyClosed, autoSmooth } from './trace.js';
import { make3MF, makeSTL } from './export.js';

const $ = (id) => document.getElementById(id);
const STORE = 'fitforge.v1';
const VIRTUAL_MPP = 0.1;      // no-photo mode: 1 px = 0.1 mm
const VIRTUAL_SIZE = 3000;    // 300 mm work area

// ---------------------------------------------------------------- state
const S = {
  photo: null, img: null, iw: 0, ih: 0,
  virtual: false,
  mmPerPx: null, scalePts: [], scaleMM: 100,
  pts: [],
  tool: 'add', labels: true,
  params: { mode: 'solid', thickness: 5, clearanceS: 0, clearanceH: 0.2, depth: 10, floor: 2, wall: 3,
    outer: 'follow', outerR: 3, slice: false, name: 'fitforge-part' },
};
const view = { x: 0, y: 0, z: 1 };
let tab = 'photo';
let undoStack = [];
let gray = null, lastSeed = null;
let labelBoxes = [];
let wasm = null, viewer = null, lastMesh = null;

const mpp = () => S.mmPerPx || VIRTUAL_MPP;
const scaled = () => !!S.mmPerPx;
const fmt = (v) => (Math.round(v * 100) / 100).toString();

// ---------------------------------------------------------------- persistence
function save() {
  const data = { ...S, img: undefined };
  try { localStorage.setItem(STORE, JSON.stringify(data)); }
  catch (e) {
    try { localStorage.setItem(STORE, JSON.stringify({ ...data, photo: null })); toast('Photo too big to keep after reload — shape is saved.'); } catch {}
  }
}
async function load() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch {}
  if (!d) return;
  Object.assign(S, d, { img: null });
  S.params = { ...S.params, ...(d.params || {}) };
  if (S.photo) await setImage(S.photo, false);
}
function pushUndo() {
  undoStack.push(JSON.stringify(S.pts));
  if (undoStack.length > 60) undoStack.shift();
}

// ---------------------------------------------------------------- toast / hint / status
let toastT;
function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toastT); toastT = setTimeout(() => (t.style.display = 'none'), ms);
}
function updateHint() {
  let h = '';
  if (tab === 'photo') h = S.img || S.virtual ? '' : 'Take a photo with a ruler in it, or start from a rectangle';
  else if (tab === 'scale') {
    if (S.virtual) h = 'No photo — scale is fixed (grid squares are 10 mm)';
    else if (!S.img) h = 'Add a photo first';
    else if (S.scalePts.length < 2) h = `Tap ruler mark ${S.scalePts.length + 1} of 2 · pinch to zoom`;
    else h = 'Drag handles to fine-tune, then Set scale';
  } else if (tab === 'shape') {
    h = { add: 'Tap to add corners in order · tap an edge to insert a point', move: 'Drag points to adjust · tap a corner or label to edit', trace: 'Tap on the object to trace its outline' }[S.tool];
  }
  $('hintText').textContent = h;
  $('hint').style.display = h ? '' : 'none';
}
function updateStatus() {
  let s;
  if (S.virtual) s = 'No photo · mm grid';
  else if (!S.img) s = 'No photo yet';
  else s = scaled() ? `Scale ${fmt(1 / S.mmPerPx)} px/mm` : '⚠ Not scaled';
  if (S.pts.length >= 3) {
    const { poly } = buildOutline(S.pts, mpp());
    const b = bbox(poly);
    s += ` · ${fmt(b.w)} × ${fmt(b.h)} mm${scaled() ? '' : '?'}`;
  }
  $('status').textContent = s;
  if (tab === 'shape' && document.activeElement !== $('sizeW') && document.activeElement !== $('sizeH')) refreshSizeInputs();
}

// ---------------------------------------------------------------- canvas & view
const cv = $('cv');
const ctx = cv.getContext('2d');
const dpr = () => Math.min(3, window.devicePixelRatio || 1);
function resizeCanvas() {
  const r = cv.getBoundingClientRect();
  cv.width = Math.round(r.width * dpr()); cv.height = Math.round(r.height * dpr());
  draw();
}
new ResizeObserver(resizeCanvas).observe(cv);

const toWorld = (sx, sy) => [(sx - view.x) / view.z, (sy - view.y) / view.z];
const toScreen = (wx, wy) => [wx * view.z + view.x, wy * view.z + view.y];

function worldBounds() {
  if (S.img) return { x0: 0, y0: 0, x1: S.iw, y1: S.ih };
  if (S.pts.length) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of S.pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const m = Math.max(x1 - x0, y1 - y0) * 0.35 + 50;
    return { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
  }
  return { x0: 0, y0: 0, x1: VIRTUAL_SIZE, y1: VIRTUAL_SIZE };
}
function fitView() {
  const r = cv.getBoundingClientRect();
  if (!r.width) return;
  const b = worldBounds();
  const z = Math.min(r.width / (b.x1 - b.x0), r.height / (b.y1 - b.y0)) * 0.94;
  view.z = z;
  view.x = r.width / 2 - ((b.x0 + b.x1) / 2) * z;
  view.y = r.height / 2 - ((b.y0 + b.y1) / 2) * z;
  draw();
}

function drawGrid(c, x0, y0, x1, y1, z) {
  const step = 10 / VIRTUAL_MPP; // 10 mm
  c.fillStyle = '#f4f1ea'; c.fillRect(x0, y0, x1 - x0, y1 - y0);
  const sx = Math.floor(x0 / step) * step, sy = Math.floor(y0 / step) * step;
  for (let x = sx; x <= x1; x += step) {
    const major = Math.round(x / step) % 5 === 0;
    c.strokeStyle = major ? '#c9c2b4' : '#e2ddd2'; c.lineWidth = (major ? 1.4 : 1) / z;
    c.beginPath(); c.moveTo(x, y0); c.lineTo(x, y1); c.stroke();
  }
  for (let y = sy; y <= y1; y += step) {
    const major = Math.round(y / step) % 5 === 0;
    c.strokeStyle = major ? '#c9c2b4' : '#e2ddd2'; c.lineWidth = (major ? 1.4 : 1) / z;
    c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke();
  }
}

function outlinePx() {
  if (S.pts.length < 3) return { poly: [], effR: [] };
  const m = mpp();
  const { poly, effR } = buildOutline(S.pts, m);
  return { poly: poly.map(([x, y]) => [x / m, -y / m]), effR };
}

function drawWorld(c, z) {
  // background
  const r = cv.getBoundingClientRect();
  const [wx0, wy0] = toWorld(0, 0), [wx1, wy1] = toWorld(r.width, r.height);
  if (S.img) c.drawImage(S.img, 0, 0);
  else if (S.virtual) drawGrid(c, wx0, wy0, wx1, wy1, z);
  // outline
  const { poly } = outlinePx();
  if (poly.length > 2) {
    c.beginPath();
    poly.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.closePath();
    c.fillStyle = 'rgba(255,159,67,0.22)'; c.fill();
    c.strokeStyle = '#ff9f43'; c.lineWidth = 2.2 / z; c.stroke();
  } else if (S.pts.length === 2) {
    c.beginPath(); c.moveTo(S.pts[0].x, S.pts[0].y); c.lineTo(S.pts[1].x, S.pts[1].y);
    c.strokeStyle = '#ff9f43'; c.lineWidth = 2.2 / z; c.stroke();
  }
}

function draw() {
  const D = dpr();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0e1115'; ctx.fillRect(0, 0, cv.width, cv.height);
  if (tab === 'model') return;
  ctx.setTransform(D * view.z, 0, 0, D * view.z, D * view.x, D * view.y);
  drawWorld(ctx, view.z);
  ctx.setTransform(D, 0, 0, D, 0, 0);
  labelBoxes = [];

  if (tab === 'scale' && S.scalePts.length) {
    const sp = S.scalePts.map(p => toScreen(p.x, p.y));
    if (sp.length === 2) {
      ctx.strokeStyle = '#4cc3ff'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(...sp[0]); ctx.lineTo(...sp[1]); ctx.stroke(); ctx.setLineDash([]);
      const d = Math.hypot(S.scalePts[1].x - S.scalePts[0].x, S.scalePts[1].y - S.scalePts[0].y);
      pill((sp[0][0] + sp[1][0]) / 2, (sp[0][1] + sp[1][1]) / 2 - 18, `${fmt(d)} px`, '#4cc3ff');
    }
    for (const [x, y] of sp) crossHandle(x, y, '#4cc3ff');
  }

  if (tab === 'shape' || tab === 'scale' || tab === 'photo') {
    const show = tab === 'shape';
    const n = S.pts.length;
    if (show && S.labels && n >= 2) {
      const { effR } = outlinePx();
      for (let i = 0; i < (n >= 3 ? n : 1); i++) {
        const a = S.pts[i], b = S.pts[(i + 1) % n];
        const [ax, ay] = toScreen(a.x, a.y), [bx, by] = toScreen(b.x, b.y);
        if (Math.hypot(bx - ax, by - ay) < 34) continue;
        const L = Math.hypot(b.x - a.x, b.y - a.y) * mpp();
        let txt = scaled() || S.virtual ? `${fmt(L)}` : `${Math.round(L / mpp())}px`;
        if (a.arc && a.arc.R > 0) txt = `${a.arc.dir >= 0 ? '⌒' : '◡'}R${fmt(a.arc.R)} · ${txt}`;
        const box = pill((ax + bx) / 2, (ay + by) / 2, txt, '#ffffff', '#000000c0');
        labelBoxes.push({ i, ...box });
      }
      // corner radius labels
      S.pts.forEach((p, i) => {
        if (p.r > 0 && !p.smooth) {
          const [x, y] = toScreen(p.x, p.y);
          const eff = effR[i];
          const t = eff && Math.abs(eff - p.r) > 0.01 ? `R${fmt(p.r)}→${fmt(eff)}` : eff ? `R${fmt(p.r)}` : `R${fmt(p.r)}✕`;
          pill(x, y - 20, t, '#3ddc84', '#000000c0');
        }
      });
    }
    if (show || tab === 'photo') {
      S.pts.forEach((p, i) => {
        const [x, y] = toScreen(p.x, p.y);
        ctx.beginPath(); ctx.arc(x, y, show ? 7 : 4, 0, Math.PI * 2);
        ctx.fillStyle = p.smooth ? '#14181d' : (i === 0 ? '#ffffff' : '#ff9f43');
        ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = p.smooth ? '#4cc3ff' : '#14181d'; ctx.stroke();
      });
    }
  }
}

function pill(x, y, text, color = '#fff', bg = '#000000b0') {
  ctx.font = '600 12px -apple-system, Roboto, sans-serif';
  const w = ctx.measureText(text).width + 12, h = 20;
  const bx = x - w / 2, by = y - h / 2;
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.roundRect(bx, by, w, h, 6); ctx.fill();
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
  return { x: bx, y: by, w, h };
}
function crossHandle(x, y, col) {
  ctx.strokeStyle = '#000'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = col; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y); ctx.moveTo(x, y - 6); ctx.lineTo(x, y + 6); ctx.stroke();
}

// ---------------------------------------------------------------- loupe
const loupe = $('loupe'), lctx = loupe.getContext('2d');
function showLoupe(wx, wy, sx, sy) {
  const r = cv.getBoundingClientRect();
  loupe.style.display = 'block';
  const left = sx < r.width / 2 && sy < 170;
  loupe.style.left = left ? '' : '10px';
  loupe.style.right = left ? '10px' : '';
  const mag = view.z * 3;          // css px per world px
  const k = 260 / 130;             // loupe canvas px per css px
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.fillStyle = '#000'; lctx.fillRect(0, 0, 260, 260);
  lctx.setTransform(mag * k, 0, 0, mag * k, 130 - wx * mag * k, 130 - wy * mag * k);
  if (S.img) lctx.drawImage(S.img, 0, 0);
  else drawGrid(lctx, wx - 200 / mag, wy - 200 / mag, wx + 200 / mag, wy + 200 / mag, mag * k);
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.strokeStyle = '#ff9f43'; lctx.lineWidth = 2;
  lctx.beginPath(); lctx.moveTo(130, 100); lctx.lineTo(130, 160); lctx.moveTo(100, 130); lctx.lineTo(160, 130); lctx.stroke();
}
const hideLoupe = () => (loupe.style.display = 'none');

// ---------------------------------------------------------------- hit tests
function hitPoint(sx, sy, list = S.pts, rad = 24) {
  let best = -1, bd = rad;
  list.forEach((p, i) => { const [x, y] = toScreen(p.x, p.y); const d = Math.hypot(x - sx, y - sy); if (d < bd) { bd = d; best = i; } });
  return best;
}
function hitLabel(sx, sy) {
  for (const b of labelBoxes) if (sx >= b.x - 4 && sx <= b.x + b.w + 4 && sy >= b.y - 6 && sy <= b.y + b.h + 6) return b.i;
  return -1;
}
function hitEdge(sx, sy) {
  const n = S.pts.length; if (n < 2) return -1;
  let best = -1, bd = 16;
  for (let i = 0; i < n; i++) {
    const a = toScreen(S.pts[i].x, S.pts[i].y), b = toScreen(S.pts[(i + 1) % n].x, S.pts[(i + 1) % n].y);
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((sx - a[0]) * dx + (sy - a[1]) * dy) / l2));
    const d = Math.hypot(sx - a[0] - t * dx, sy - a[1] - t * dy);
    if (d < bd && t > 0.08 && t < 0.92) { bd = d; best = i; }
  }
  return best;
}

// ---------------------------------------------------------------- pointer handling
const ptrs = new Map();
let G = null;
const local = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId);
  const [x, y] = local(e);
  ptrs.set(e.pointerId, { x, y });
  if (ptrs.size === 2) {
    const [p1, p2] = [...ptrs.values()];
    G = { type: 'pinch', d0: Math.hypot(p2.x - p1.x, p2.y - p1.y), c0: [(p1.x + p2.x) / 2, (p1.y + p2.y) / 2], v0: { ...view } };
    hideLoupe();
    return;
  }
  if (ptrs.size > 2) return;
  let g = { type: 'pan', sx: x, sy: y, v0: { ...view }, moved: false };
  if (tab === 'scale' && S.img && !S.virtual) {
    const i = hitPoint(x, y, S.scalePts, 28);
    if (i >= 0) g = { type: 'scale', idx: i, sx: x, sy: y, moved: false };
  } else if (tab === 'shape' && S.tool !== 'trace') {
    if (hitLabel(x, y) < 0) {
      const i = hitPoint(x, y);
      if (i >= 0) g = { type: 'pt', idx: i, sx: x, sy: y, moved: false };
    }
  }
  G = g;
});

cv.addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId)) return;
  const [x, y] = local(e);
  ptrs.set(e.pointerId, { x, y });
  if (!G) return;
  if (G.type === 'pinch' && ptrs.size >= 2) {
    const [p1, p2] = [...ptrs.values()];
    const d = Math.hypot(p2.x - p1.x, p2.y - p1.y), c = [(p1.x + p2.x) / 2, (p1.y + p2.y) / 2];
    const z = Math.max(0.02, Math.min(60, G.v0.z * d / (G.d0 || 1)));
    const wx = (G.c0[0] - G.v0.x) / G.v0.z, wy = (G.c0[1] - G.v0.y) / G.v0.z;
    view.z = z; view.x = c[0] - wx * z; view.y = c[1] - wy * z;
    draw(); return;
  }
  if (ptrs.size !== 1) return;
  const dist = Math.hypot(x - G.sx, y - G.sy);
  if (!G.moved && dist < 6) return;
  if (G.type === 'pan') {
    G.moved = true;
    view.x = G.v0.x + (x - G.sx); view.y = G.v0.y + (y - G.sy);
    draw();
  } else if (G.type === 'pt' || G.type === 'scale') {
    if (!G.moved && G.type === 'pt') pushUndo();
    G.moved = true;
    // offset finger so the point being dragged stays visible above the fingertip
    const [wx, wy] = toWorld(x, y);
    const p = G.type === 'pt' ? S.pts[G.idx] : S.scalePts[G.idx];
    p.x = wx; p.y = wy;
    showLoupe(wx, wy, x, y);
    draw(); updateStatus();
  }
});

function endPointer(e) {
  if (!ptrs.has(e.pointerId)) return;
  const [x, y] = local(e);
  ptrs.delete(e.pointerId);
  if (!G) return;
  if (G.type === 'pinch') { if (ptrs.size === 0) G = null; else G = { type: 'none' }; return; }
  if (ptrs.size) return;
  const g = G; G = null;
  hideLoupe();
  if (g.type === 'none') return;
  if (!g.moved) handleTap(x, y);
  save(); updateStatus(); updateHint();
}
cv.addEventListener('pointerup', endPointer);
cv.addEventListener('pointercancel', endPointer);
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  const [x, y] = local(e);
  const k = Math.exp(-e.deltaY * 0.0015);
  const [wx, wy] = toWorld(x, y);
  view.z = Math.max(0.02, Math.min(60, view.z * k));
  view.x = x - wx * view.z; view.y = y - wy * view.z;
  draw();
}, { passive: false });

function handleTap(x, y) {
  const [wx, wy] = toWorld(x, y);
  if (tab === 'scale') {
    if (!S.img || S.virtual) return;
    if (S.scalePts.length < 2) S.scalePts.push({ x: wx, y: wy });
    else {
      const d0 = Math.hypot(S.scalePts[0].x - wx, S.scalePts[0].y - wy), d1 = Math.hypot(S.scalePts[1].x - wx, S.scalePts[1].y - wy);
      S.scalePts[d0 < d1 ? 0 : 1] = { x: wx, y: wy };
    }
    draw(); updateScaleStat(); return;
  }
  if (tab !== 'shape') return;
  if (!S.img && !S.virtual) { toast('Add a photo or start from a rectangle first'); return; }
  const li = hitLabel(x, y);
  if (li >= 0) { openEdgeSheet(li); return; }
  if (S.tool === 'trace') { runTrace(wx, wy, true); return; }
  const pi = hitPoint(x, y);
  if (pi >= 0) { openPointSheet(pi); return; }
  if (S.tool === 'add') {
    pushUndo();
    const ei = S.pts.length >= 3 ? hitEdge(x, y) : -1;
    if (ei >= 0) S.pts.splice(ei + 1, 0, { x: wx, y: wy });
    else S.pts.push({ x: wx, y: wy });
    draw(); updateStatus();
  }
}

// ---------------------------------------------------------------- photo
async function setImage(src, fresh = true) {
  const img = new Image();
  img.decoding = 'async';
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
  S.img = img; S.iw = img.naturalWidth; S.ih = img.naturalHeight;
  gray = null;
  if (fresh) {
    S.virtual = false; S.mmPerPx = null; S.scalePts = []; S.pts = []; undoStack = [];
  }
}
async function onFile(file) {
  if (!file) return;
  $('status').textContent = 'Loading photo…';
  const url = URL.createObjectURL(file);
  try {
    const tmp = new Image();
    await new Promise((res, rej) => { tmp.onload = res; tmp.onerror = rej; tmp.src = url; });
    const max = 2400, s = Math.min(1, max / Math.max(tmp.naturalWidth, tmp.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(tmp.naturalWidth * s); c.height = Math.round(tmp.naturalHeight * s);
    c.getContext('2d').drawImage(tmp, 0, 0, c.width, c.height);
    S.photo = c.toDataURL('image/jpeg', 0.88);
    await setImage(S.photo, true);
    fitView(); save(); setTab('scale');
    toast('Photo loaded — now tap two ruler marks');
  } catch (e) { toast('Could not read that image'); }
  finally { URL.revokeObjectURL(url); updateStatus(); }
}
$('btnCamera').onclick = () => $('fileCamera').click();
$('btnLibrary').onclick = () => $('fileLibrary').click();
$('fileCamera').onchange = (e) => { onFile(e.target.files[0]); e.target.value = ''; };
$('fileLibrary').onchange = (e) => { onFile(e.target.files[0]); e.target.value = ''; };

$('btnRect').onclick = () => {
  const w = +$('rectW').value || 60, h = +$('rectH').value || 30;
  S.photo = null; S.img = null; S.virtual = true; S.mmPerPx = VIRTUAL_MPP; S.scalePts = []; gray = null;
  undoStack = [];
  const c = VIRTUAL_SIZE / 2, pw = w / VIRTUAL_MPP / 2, ph = h / VIRTUAL_MPP / 2;
  S.pts = [{ x: c - pw, y: c - ph }, { x: c + pw, y: c - ph }, { x: c + pw, y: c + ph }, { x: c - pw, y: c + ph }];
  save(); fitView(); setTab('shape'); setTool('move');
  toast('Tap a corner to round it · tap a length to change it');
};
$('btnNew').onclick = () => {
  if ($('btnNew').dataset.armed !== '1') {
    $('btnNew').dataset.armed = '1'; $('btnNew').textContent = 'Tap again to erase everything';
    setTimeout(() => { $('btnNew').dataset.armed = ''; $('btnNew').textContent = '🗑 New project'; }, 3000);
    return;
  }
  localStorage.removeItem(STORE); location.reload();
};

// ---------------------------------------------------------------- scale
function updateScaleStat() {
  let t = '';
  if (S.virtual) t = 'No photo: 1 grid square = 10 mm.';
  else if (S.mmPerPx) t = `✔ Scale set: ${fmt(1 / S.mmPerPx)} px per mm (≈${fmt(S.mmPerPx * 2)} mm per photo pixel pair). Re-set anytime.`;
  else t = S.scalePts.length < 2 ? `${S.scalePts.length}/2 marks placed` : 'Ready — tap Set scale';
  $('scaleStat').textContent = t;
}
$('scaleMM').value = S.scaleMM;
$('btnSetScale').onclick = () => {
  if (S.scalePts.length < 2) return toast('Tap two ruler marks first');
  const mm = +$('scaleMM').value;
  if (!(mm > 0)) return toast('Enter the distance in mm');
  const px = Math.hypot(S.scalePts[1].x - S.scalePts[0].x, S.scalePts[1].y - S.scalePts[0].y);
  if (px < 20) return toast('Marks are too close together');
  S.scaleMM = mm; S.mmPerPx = mm / px;
  save(); updateScaleStat(); updateStatus(); draw();
  toast(`Scale set ✔ — now outline the shape`);
  setTimeout(() => setTab('shape'), 700);
};
$('btnResetScale').onclick = () => { S.scalePts = []; S.mmPerPx = S.virtual ? VIRTUAL_MPP : null; save(); updateScaleStat(); updateStatus(); draw(); updateHint(); };

// ---------------------------------------------------------------- shape tools
function setTool(t) {
  S.tool = t;
  document.querySelectorAll('#tools button').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  $('traceRow').style.display = t === 'trace' ? '' : 'none';
  if (t === 'trace' && !S.img) toast('Auto-trace needs a photo');
  updateHint(); draw();
}
document.querySelectorAll('#tools button').forEach(b => (b.onclick = () => setTool(b.dataset.tool)));
$('btnUndo').onclick = () => { if (!undoStack.length) return toast('Nothing to undo'); S.pts = JSON.parse(undoStack.pop()); save(); draw(); updateStatus(); };
$('btnClear').onclick = () => { if (!S.pts.length) return; pushUndo(); S.pts = []; lastSeed = null; save(); draw(); updateStatus(); toast('Cleared — Undo brings it back'); };
$('btnLabels').onclick = () => { S.labels = !S.labels; $('btnLabels').textContent = `Labels: ${S.labels ? 'on' : 'off'}`; draw(); };

function runTrace(wx, wy, fresh) {
  if (!S.img) return toast('Auto-trace needs a photo');
  if (!gray) gray = grayFromImage(S.img, 1600);
  const sens = +$('traceSens').value;
  const r = regionFrom(gray, wx * gray.scale, wy * gray.scale, sens);
  if (r.frac > 0.6) { toast('That grabbed the background — tap on the object itself, or change sensitivity'); return; }
  if (r.area < 30) { toast('Region too small — try adjusting sensitivity'); return; }
  const b = traceBoundary(r.mask, gray.w, gray.h);
  const simp = simplifyClosed(b, 70);
  if (simp.length < 3) return toast('Could not trace that');
  if (fresh) pushUndo();
  lastSeed = { wx, wy };
  S.pts = autoSmooth(simp.map(([x, y]) => ({ x: x / gray.scale, y: y / gray.scale })));
  save(); draw(); updateStatus();
  if (fresh) toast(`Traced ${S.pts.length} points — switch to ✋ Edit to fine-tune`);
}
$('traceSens').oninput = () => { if (lastSeed) runTrace(lastSeed.wx, lastSeed.wy, false); };

function shapeBBoxMM() {
  if (S.pts.length < 3) return null;
  return bbox(buildOutline(S.pts, mpp()).poly);
}
function refreshSizeInputs() {
  const b = shapeBBoxMM();
  $('sizeW').value = b ? fmt(b.w) : ''; $('sizeH').value = b ? fmt(b.h) : '';
}
$('btnSize').onclick = () => {
  if (S.pts.length < 3) return toast('Outline the shape first');
  if (!scaled() && !S.virtual) return toast('Set the scale first');
  const W = +$('sizeW').value, H = +$('sizeH').value;
  if (!(W > 0 && H > 0)) return toast('Enter width and height in mm');
  pushUndo();
  for (let k = 0; k < 4; k++) {
    const b = shapeBBoxMM();
    const sx = W / b.w, sy = H / b.h;
    const cx = (b.x0 + b.x1) / 2 / mpp(), cy = -(b.y0 + b.y1) / 2 / mpp();
    S.pts.forEach(p => { p.x = cx + (p.x - cx) * sx; p.y = cy + (p.y - cy) * sy; });
  }
  save(); draw(); updateStatus(); refreshSizeInputs();
  toast('Resized to your measurements');
};

// ---------------------------------------------------------------- bottom sheets (radius gauge + lengths)
const sheet = $('sheet'), box = $('sheetBox');
let sheetOpenedAt = 0;
function openSheet(html, bind) { box.innerHTML = html; sheet.classList.add('on'); sheetOpenedAt = performance.now(); bind(); }
function closeSheet() { sheet.classList.remove('on'); save(); draw(); updateStatus(); refreshSizeInputs(); }
sheet.addEventListener('click', (e) => { if (e.target === sheet && performance.now() - sheetOpenedAt > 450) closeSheet(); });
const chips = (vals, cur, attr) => `<div class="chips">${vals.map(v => `<button class="chip${+cur === v ? ' on' : ''}" ${attr}="${v}">${v === 0 ? 'Sharp' : 'R' + v}</button>`).join('')}</div>`;

function openPointSheet(i) {
  const p = S.pts[i], n = S.pts.length;
  const prevCurved = S.pts[(i - 1 + n) % n].arc || S.pts[(i - 1 + n) % n].smooth;
  const nextCurved = p.arc || S.pts[(i + 1) % n].smooth;
  openSheet(`
    <h3>Corner ${i + 1} of ${n}</h3>
    <div class="tip">Find the leaf on your <b>radius gauge</b> that sits flush on this corner and enter its radius.</div>
    <div class="row"><label class="f">Corner radius (mm)<input type="number" id="shR" value="${p.r || 0}" step="0.5" inputmode="decimal"></label></div>
    ${chips([0, 0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25], p.r || 0, 'data-r')}
    ${prevCurved || nextCurved ? '<div class="tip">⚠ A radius only applies between two straight edges — this corner touches a curved edge.</div>' : ''}
    <label class="check"><input type="checkbox" id="shSmooth" ${p.smooth ? 'checked' : ''}> Smooth curve through this point (for freeform curves)</label>
    <div class="row">
      <button class="btn" id="shDel">Delete point</button>
      <button class="btn pri grow" id="shDone">Done</button>
    </div>`, () => {
    const setR = (v) => { p.r = Math.max(0, +v || 0); draw(); };
    $('shR').oninput = (e) => setR(e.target.value);
    box.querySelectorAll('[data-r]').forEach(b => (b.onclick = () => {
      pushUndo(); setR(b.dataset.r); $('shR').value = b.dataset.r;
      box.querySelectorAll('[data-r]').forEach(c => c.classList.toggle('on', c === b));
    }));
    $('shSmooth').onchange = (e) => { pushUndo(); p.smooth = e.target.checked; draw(); };
    $('shDel').onclick = () => { pushUndo(); S.pts.splice(i, 1); closeSheet(); };
    $('shDone').onclick = closeSheet;
  });
}

function openEdgeSheet(i) {
  const n = S.pts.length, a = S.pts[i], b = S.pts[(i + 1) % n];
  const L = Math.hypot(b.x - a.x, b.y - a.y) * mpp();
  const kind = a.arc && a.arc.R > 0 ? (a.arc.dir >= 0 ? 'out' : 'in') : 'straight';
  const R = a.arc?.R || Math.ceil(L * 0.75);
  openSheet(`
    <h3>Edge ${i + 1} → ${((i + 1) % n) + 1}</h3>
    <div class="row">
      <label class="f">${kind === 'straight' ? 'Length' : 'Straight-line (chord) length'} (mm)<input type="number" id="edL" value="${fmt(L)}" step="0.1" inputmode="decimal"></label>
      <button class="btn" id="edSetL" style="align-self:flex-end">Set</button>
    </div>
    <label class="check"><input type="checkbox" id="edKeep" ${S.keepNext !== false ? 'checked' : ''}> Shift the next corner too (keeps the next edge square)</label>
    <hr>
    <div class="tip"><b>Curved edge?</b> Match it with your radius gauge.</div>
    <div class="seg" id="edKind">
      <button data-k="straight" class="${kind === 'straight' ? 'on' : ''}">Straight</button>
      <button data-k="out" class="${kind === 'out' ? 'on' : ''}">⌒ Bulges out</button>
      <button data-k="in" class="${kind === 'in' ? 'on' : ''}">◡ Curves in</button>
    </div>
    <div class="row"><label class="f">Arc radius (mm)<input type="number" id="edR" value="${fmt(R)}" step="0.5" inputmode="decimal"></label></div>
    ${chips([5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150], a.arc?.R, 'data-ar')}
    <div class="tip" id="edNote"></div>
    <div class="row">
      <button class="btn" id="edMid">＋ Point in middle</button>
      <button class="btn pri grow" id="edDone">Done</button>
    </div>`, () => {
    let k = kind;
    const note = () => {
      const chord = Math.hypot(b.x - a.x, b.y - a.y) * mpp();
      const r = +$('edR').value;
      $('edNote').textContent = k !== 'straight' && r < chord / 2 ? `Radius can't be smaller than half the edge (${fmt(chord / 2)} mm) — using that.` : '';
    };
    const apply = () => {
      if (k === 'straight') delete a.arc;
      else a.arc = { R: Math.max(0.1, +$('edR').value || 1), dir: k === 'out' ? 1 : -1 };
      note(); draw(); updateStatus();
    };
    box.querySelectorAll('#edKind button').forEach(btn => (btn.onclick = () => {
      pushUndo(); k = btn.dataset.k;
      box.querySelectorAll('#edKind button').forEach(c => c.classList.toggle('on', c === btn));
      apply();
    }));
    $('edR').oninput = () => { if (k !== 'straight') apply(); };
    box.querySelectorAll('[data-ar]').forEach(btn => (btn.onclick = () => {
      pushUndo(); $('edR').value = btn.dataset.ar;
      if (k === 'straight') { k = 'out'; box.querySelectorAll('#edKind button').forEach(c => c.classList.toggle('on', c.dataset.k === 'out')); }
      box.querySelectorAll('[data-ar]').forEach(c => c.classList.toggle('on', c === btn));
      apply();
    }));
    $('edSetL').onclick = () => {
      if (!scaled() && !S.virtual) return toast('Set the scale first');
      const nl = +$('edL').value; if (!(nl > 0)) return;
      pushUndo();
      const cur = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const f = (nl / mpp()) / cur;
      const nx = a.x + (b.x - a.x) * f, ny = a.y + (b.y - a.y) * f;
      const dx = nx - b.x, dy = ny - b.y;
      b.x = nx; b.y = ny;
      S.keepNext = $('edKeep').checked;
      const c = S.pts[(i + 2) % n];
      if (S.keepNext && n >= 4 && c !== a) { c.x += dx; c.y += dy; }
      draw(); updateStatus(); note(); toast(`Edge set to ${fmt(nl)} mm`);
    };
    $('edMid').onclick = () => { pushUndo(); S.pts.splice(i + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }); closeSheet(); };
    $('edDone').onclick = closeSheet;
    note();
  });
}

// ---------------------------------------------------------------- 3D model + export
const P = S.params;
function bindParam(id, key, num = true) {
  const el = $(id);
  if (el.type === 'checkbox') el.checked = !!P[key]; else el.value = P[key];
  el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', () => {
    P[key] = el.type === 'checkbox' ? el.checked : (num ? parseFloat(el.value) : el.value);
    save(); scheduleBuild();
  });
}
function initParams() {
  bindParam('pThickness', 'thickness'); bindParam('pClearanceS', 'clearanceS');
  bindParam('pDepth', 'depth'); bindParam('pFloor', 'floor'); bindParam('pWall', 'wall');
  bindParam('pClearanceH', 'clearanceH'); bindParam('pOuter', 'outer', false); bindParam('pOuterR', 'outerR');
  bindParam('pSlice', 'slice'); bindParam('pName', 'name', false);
  setMode(P.mode);
}
function setMode(m) {
  P.mode = m;
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  $('solidOpts').style.display = m === 'solid' ? '' : 'none';
  $('holderOpts').style.display = m === 'holder' ? '' : 'none';
  if (viewer) viewer.needsFit = true;
  save(); scheduleBuild();
}
document.querySelectorAll('#modeSeg button').forEach(b => (b.onclick = () => setMode(b.dataset.mode)));

async function ensureWasm() {
  if (wasm) return wasm;
  $('modelStat').textContent = 'Loading geometry engine…';
  const Module = (await import('manifold-3d')).default;
  wasm = await Module(); wasm.setup();
  return wasm;
}
async function ensureViewer() {
  if (viewer) return viewer;
  const { Viewer } = await import('./viewer.js');
  viewer = new Viewer($('view3d'));
  viewer.resize();
  return viewer;
}
let buildT;
function scheduleBuild() { clearTimeout(buildT); if (tab === 'model') buildT = setTimeout(build, 180); }
async function build() {
  if (S.pts.length < 3) { $('modelStat').textContent = 'Outline a shape with at least 3 points first (Shape tab).'; lastMesh = null; if (viewer) viewer.setMesh(null); return; }
  if (!scaled() && !S.virtual) { $('modelStat').textContent = '⚠ Scale not set — sizes will be wrong. Set it on the Scale tab.'; }
  try {
    await ensureWasm(); await ensureViewer();
    const { poly } = buildOutline(S.pts, mpp());
    const params = { ...P, clearance: P.mode === 'holder' ? P.clearanceH : P.clearanceS };
    const m = buildSolid(wasm, poly, params);
    lastMesh = m;
    viewer.setMesh(m);
    if (!m) return;
    const warn = !scaled() && !S.virtual ? ' ⚠ not scaled' : '';
    $('modelStat').textContent = `${fmt(m.size[0])} × ${fmt(m.size[1])} × ${fmt(m.size[2])} mm · ${fmt(m.volume / 1000)} cm³ · ~${fmt(m.volume / 1000 * 1.24)} g PLA${P.slice ? ' · TEST SLICE' : ''}${warn}`;
  } catch (e) {
    console.error(e);
    $('modelStat').textContent = 'Could not build the solid — check the outline for crossing edges.';
  }
}
function fileName(ext) { return ((P.name || 'fitforge-part').replace(/[^\w\- ]+/g, '').trim() || 'fitforge-part') + (P.slice ? '-testslice' : '') + '.' + ext; }
function download(bytes, name, type) {
  const blob = new Blob([bytes], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function exportAs(kind) {
  await build();
  if (!lastMesh) return toast('Nothing to export yet');
  if (kind === '3mf') download(make3MF(lastMesh, P.name), fileName('3mf'), 'model/3mf');
  else download(makeSTL(lastMesh), fileName('stl'), 'model/stl');
  toast(`Saved ${fileName(kind)}`);
}
$('btn3mf').onclick = () => exportAs('3mf');
$('btnStl').onclick = () => exportAs('stl');
$('btnShare').onclick = async () => {
  await build();
  if (!lastMesh) return toast('Nothing to share yet');
  const file = new File([make3MF(lastMesh, P.name)], fileName('3mf'), { type: 'model/3mf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: P.name }); } catch {}
  } else toast('Sharing files isn’t supported here — use Export');
};

// ---------------------------------------------------------------- tabs
function setTab(t) {
  tab = t;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.sec').forEach(s => s.classList.toggle('on', s.dataset.sec === t));
  const is3d = t === 'model';
  $('view3d').style.display = is3d ? 'block' : 'none';
  cv.style.visibility = is3d ? 'hidden' : 'visible';
  if (is3d) { if (viewer) viewer.needsFit = true; build(); }
  if (t === 'scale') updateScaleStat();
  if (t === 'shape') refreshSizeInputs();
  updateHint(); draw();
}
document.querySelectorAll('#nav button').forEach(b => (b.onclick = () => setTab(b.dataset.tab)));

// ---------------------------------------------------------------- boot
(async function boot() {
  await load();
  $('scaleMM').value = S.scaleMM;
  $('btnLabels').textContent = `Labels: ${S.labels ? 'on' : 'off'}`;
  initParams();
  setTool(S.tool || 'add');
  resizeCanvas(); fitView();
  setTab(S.img || S.virtual ? (S.pts.length ? 'shape' : (scaled() || S.virtual ? 'shape' : 'scale')) : 'photo');
  updateStatus();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  window.__fitforge = { S, view, build, setTab, handleTap, toWorld, toScreen };
})();
