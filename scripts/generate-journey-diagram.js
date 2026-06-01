/* eslint-disable */
// Generates docs/customer-journey.{excalidraw,svg,png}
// Run: node scripts/generate-journey-diagram.js

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT_DIR = path.join(__dirname, '..', 'docs');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---------- palette ----------
const C = {
  applicant: { bg: '#a5d8ff', stroke: '#1864ab' },
  system:    { bg: '#d0bfff', stroke: '#5f3dc4' },
  finscore:  { bg: '#eebefa', stroke: '#862e9c' },
  email:     { bg: '#e9ecef', stroke: '#343a40' },
  stage:     { bg: '#ffe066', stroke: '#e67700' },
  verifier:  { bg: '#99e9f2', stroke: '#0b7285' },
  ci:        { bg: '#ffd8a8', stroke: '#d9480f' },
  approver:  { bg: '#b2f2bb', stroke: '#2b8a3e' },
  encoder:   { bg: '#fcc2d7', stroke: '#a61e4d' },
  loandisk:  { bg: '#ffa8a8', stroke: '#c92a2a' },
  decision:  { bg: '#f8f9fa', stroke: '#212529' },
  decline:   { bg: '#ffc9c9', stroke: '#c92a2a' },
  so:        { bg: '#d8f5a2', stroke: '#2b8a3e' },
};

// ---------- nodes ----------
const NODES = {
  // main spine
  n1:  { actor: 'applicant', shape: 'rect',    title: 'Applicant fills form',             sub: 'Personal / SME / AKAP / Group / SBL' },
  n2:  { actor: 'applicant', shape: 'rect',    title: 'POST /api/application/submit',     sub: '(/submit-group for Group & SBL)' },
  n3:  { actor: 'system',    shape: 'rect',    title: 'Pre-qualification checks',         sub: 'Age 21-65  ·  income  ·  amount limits  ·  mobile fmt' },
  d1:  { actor: 'decision',  shape: 'diamond', title: 'Pre-qual pass?',                   sub: '' },
  n4:  { actor: 'finscore',  shape: 'rect',    title: 'FinScore API',                     sub: 'Telco detect (GL1 / Q1 / DT1)  →  raw 300-600' },
  n5:  { actor: 'system',    shape: 'rect',    title: 'Compress + upload files',          sub: 'sharp  →  Supabase application-files bucket' },
  n6:  { actor: 'system',    shape: 'rect',    title: 'Insert applications row',          sub: 'status = pending  ·  stage = leads  ·  ref = GR8-{ts}' },
  n7:  { actor: 'email',     shape: 'rect',    title: 'ZeptoMail: submission confirm',    sub: 'Applicant  +  internal notify' },
  n8:  { actor: 'stage',     shape: 'rect',    title: 'Stage: leads  →  verifier',        sub: 'Auto-advance on submit' },
  n9:  { actor: 'verifier',  shape: 'rect',    title: 'Verifier reviews documents',       sub: 'PATCH /api/pipeline/:id/transition' },
  d2:  { actor: 'decision',  shape: 'diamond', title: 'Verifier decision?',               sub: '' },
  n10: { actor: 'stage',     shape: 'rect',    title: 'Stage: verifier  →  ci_officer',   sub: 'Transition email fires' },
  n11: { actor: 'ci',        shape: 'rect',    title: 'CI Officer interview',             sub: 'Score 0-50  ·  PATCH /api/ci/.../ci-score' },
  n12: { actor: 'system',    shape: 'rect',    title: 'Auto-advance  →  approver',        sub: 'CI normalized = (raw / 50) * 100' },
  n13: { actor: 'email',     shape: 'rect',    title: 'ZeptoMail: SO confirmation',       sub: 'Tokenized link sent to applicant / SO' },
  n14: { actor: 'approver',  shape: 'rect',    title: 'Approver reviews',                 sub: 'final = fin*0.5 + ci*0.5 + reapp bonus  (cap 100)' },
  d3:  { actor: 'decision',  shape: 'diamond', title: 'Approver decision?',               sub: '' },
  n15: { actor: 'loandisk',  shape: 'rect',    title: 'Loandisk: create borrower',        sub: 'Transfer files via S3 presigned URLs' },
  n16: { actor: 'stage',     shape: 'rect',    title: 'Stage: approver  →  encoder',      sub: '' },
  n17: { actor: 'encoder',   shape: 'rect',    title: 'Encoder finalizes loan record',    sub: '' },
  n18: { actor: 'stage',     shape: 'rect',    title: 'Stage: encoder  →  released',      sub: 'Loan live in Loandisk' },
  n19: { actor: 'email',     shape: 'rect',    title: 'ZeptoMail: release notification',  sub: '' },
  // decline col
  x1:  { actor: 'decline',   shape: 'rect',    title: 'HTTP 400 response',                sub: 'Pre-qual failure reason returned' },
  x2:  { actor: 'decline',   shape: 'rect',    title: 'Stage: declined (verifier)',       sub: 'Decline email sent' },
  x3:  { actor: 'decline',   shape: 'rect',    title: 'Stage: declined (approver)',       sub: 'tier < 70  →  declined' },
  // SO branch
  s1:  { actor: 'so',        shape: 'rect',    title: 'SO / Applicant clicks link',       sub: 'Token in email body' },
  s2:  { actor: 'so',        shape: 'rect',    title: 'GET /api/confirm/:token',          sub: 'Validate signature + expiry' },
  s3:  { actor: 'so',        shape: 'rect',    title: 'Stamp so_confirmation_sent_at',    sub: 'so_decision persists on approver' },
};

// ---------- layout ----------
const CARD_W = 520;
const CARD_H = 110;
const DIA_W  = 320;
const DIA_H  = 160;
const V_GAP  = 180;

const COL_MAIN    = 1040;
const COL_DECLINE = 1780;
const COL_SO      = 2340;

const mainIds = ['n1','n2','n3','d1','n4','n5','n6','n7','n8','n9','d2','n10','n11','n12','n13','n14','d3','n15','n16','n17','n18','n19'];

const pos = {};
mainIds.forEach((id, i) => {
  const n = NODES[id];
  const dia = n.shape === 'diamond';
  pos[id] = {
    cx: COL_MAIN,
    cy: 140 + i * V_GAP,
    w: dia ? DIA_W : CARD_W,
    h: dia ? DIA_H : CARD_H,
  };
});

// decline col aligned with diamonds
pos.x1 = { cx: COL_DECLINE, cy: pos.d1.cy, w: CARD_W, h: CARD_H };
pos.x2 = { cx: COL_DECLINE, cy: pos.d2.cy, w: CARD_W, h: CARD_H };
pos.x3 = { cx: COL_DECLINE, cy: pos.d3.cy, w: CARD_W, h: CARD_H };

// SO branch alongside n13 → n14
pos.s1 = { cx: COL_SO, cy: pos.n13.cy,               w: CARD_W, h: CARD_H };
pos.s2 = { cx: COL_SO, cy: pos.n13.cy + V_GAP * 0.9, w: CARD_W, h: CARD_H };
pos.s3 = { cx: COL_SO, cy: pos.n14.cy + V_GAP * 0.5, w: CARD_W, h: CARD_H };

const CANVAS_W = 2720;
const CANVAS_H = pos.n19.cy + 160;

// ---------- arrows ----------
// type: down, right, returnLeft, sideIn, dashed
const ARROWS = [
  { from: 'n1', to: 'n2' },
  { from: 'n2', to: 'n3' },
  { from: 'n3', to: 'd1' },
  { from: 'd1', to: 'n4', label: 'yes' },
  { from: 'd1', to: 'x1', label: 'no',  side: 'right' },
  { from: 'n4', to: 'n5' },
  { from: 'n5', to: 'n6' },
  { from: 'n6', to: 'n7' },
  { from: 'n7', to: 'n8' },
  { from: 'n8', to: 'n9' },
  { from: 'n9', to: 'd2' },
  { from: 'd2', to: 'n10', label: 'approve' },
  { from: 'd2', to: 'x2',  label: 'decline', side: 'right' },
  { from: 'd2', to: 'n8',  label: 'return',  side: 'returnLeft' },
  { from: 'n10', to: 'n11' },
  { from: 'n11', to: 'n12' },
  { from: 'n12', to: 'n13' },
  { from: 'n13', to: 'n14' },
  { from: 'n13', to: 's1',  side: 'right' },
  { from: 's1',  to: 's2' },
  { from: 's2',  to: 's3' },
  { from: 's3',  to: 'n14', side: 'sideIn', dashed: true, label: 'confirm informs approver' },
  { from: 'n14', to: 'd3' },
  { from: 'd3',  to: 'n15', label: 'approve' },
  { from: 'd3',  to: 'x3',  label: 'decline', side: 'right' },
  { from: 'd3',  to: 'n10', label: 'return',  side: 'returnLeft' },
  { from: 'n15', to: 'n16' },
  { from: 'n16', to: 'n17' },
  { from: 'n17', to: 'n18' },
  { from: 'n18', to: 'n19' },
];

// ---------- SVG render ----------
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function shapePath(p, shape) {
  if (shape === 'diamond') {
    const x = p.cx, y = p.cy, w = p.w, h = p.h;
    return `M ${x} ${y - h/2} L ${x + w/2} ${y} L ${x} ${y + h/2} L ${x - w/2} ${y} Z`;
  }
  const x = p.cx - p.w/2, y = p.cy - p.h/2;
  return `M ${x + 14} ${y} H ${x + p.w - 14} Q ${x + p.w} ${y} ${x + p.w} ${y + 14} V ${y + p.h - 14} Q ${x + p.w} ${y + p.h} ${x + p.w - 14} ${y + p.h} H ${x + 14} Q ${x} ${y + p.h} ${x} ${y + p.h - 14} V ${y + 14} Q ${x} ${y} ${x + 14} ${y} Z`;
}

function nodeAnchor(id, side) {
  const p = pos[id];
  const n = NODES[id];
  if (n.shape === 'diamond') {
    if (side === 'top')    return { x: p.cx,           y: p.cy - p.h/2 };
    if (side === 'bottom') return { x: p.cx,           y: p.cy + p.h/2 };
    if (side === 'left')   return { x: p.cx - p.w/2,   y: p.cy };
    if (side === 'right')  return { x: p.cx + p.w/2,   y: p.cy };
  } else {
    if (side === 'top')    return { x: p.cx,           y: p.cy - p.h/2 };
    if (side === 'bottom') return { x: p.cx,           y: p.cy + p.h/2 };
    if (side === 'left')   return { x: p.cx - p.w/2,   y: p.cy };
    if (side === 'right')  return { x: p.cx + p.w/2,   y: p.cy };
  }
}

function renderArrow(a) {
  const pFrom = pos[a.from], pTo = pos[a.to];
  const stroke = a.dashed ? '#495057' : '#212529';
  const dash = a.dashed ? 'stroke-dasharray="10 6"' : '';
  let d = '';
  let labelPos = null;

  if (a.side === 'right') {
    const s = nodeAnchor(a.from, 'right');
    const e = nodeAnchor(a.to, 'left');
    d = `M ${s.x} ${s.y} L ${e.x} ${e.y}`;
    labelPos = { x: (s.x + e.x) / 2, y: s.y - 10 };
  } else if (a.side === 'returnLeft') {
    const s = nodeAnchor(a.from, 'left');
    const e = nodeAnchor(a.to, 'left');
    const bend = Math.min(s.x, e.x) - 140;
    d = `M ${s.x} ${s.y} L ${bend} ${s.y} L ${bend} ${e.y} L ${e.x} ${e.y}`;
    labelPos = { x: bend + 10, y: (s.y + e.y) / 2 };
  } else if (a.side === 'sideIn') {
    const s = nodeAnchor(a.from, 'left');
    const e = nodeAnchor(a.to, 'right');
    const bendX = e.x + 80;
    d = `M ${s.x} ${s.y} L ${bendX} ${s.y} L ${bendX} ${e.y} L ${e.x} ${e.y}`;
    labelPos = { x: bendX + 10, y: (s.y + e.y) / 2 };
  } else {
    const s = nodeAnchor(a.from, 'bottom');
    const e = nodeAnchor(a.to, 'top');
    d = `M ${s.x} ${s.y} L ${e.x} ${e.y}`;
    if (a.label) labelPos = { x: s.x + 14, y: (s.y + e.y) / 2 + 6 };
  }

  let out = `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="2.5" ${dash} marker-end="url(#ah)" />`;
  if (a.label && labelPos) {
    out += `<g><rect x="${labelPos.x - 54}" y="${labelPos.y - 18}" width="108" height="28" rx="6" fill="#ffffff" stroke="#adb5bd" stroke-width="1"/>`;
    out += `<text x="${labelPos.x}" y="${labelPos.y + 2}" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="16" fill="#212529">${esc(a.label)}</text></g>`;
  }
  return out;
}

function renderNode(id) {
  const n = NODES[id];
  const p = pos[id];
  const c = C[n.actor];
  const path = shapePath(p, n.shape);
  const titleSize = n.shape === 'diamond' ? 20 : 22;
  const subSize = 15;
  const titleY = n.sub ? p.cy - 6 : p.cy + 6;
  const subY = p.cy + 22;
  let out = `<path d="${path}" fill="${c.bg}" stroke="${c.stroke}" stroke-width="3"/>`;
  out += `<text x="${p.cx}" y="${titleY}" text-anchor="middle" dominant-baseline="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${titleSize}" font-weight="700" fill="#1a1a1a">${esc(n.title)}</text>`;
  if (n.sub) {
    out += `<text x="${p.cx}" y="${subY}" text-anchor="middle" dominant-baseline="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${subSize}" fill="#343a40">${esc(n.sub)}</text>`;
  }
  return out;
}

function renderLegend() {
  const items = [
    ['applicant', 'Applicant'],
    ['system',    'System / Backend'],
    ['finscore',  'FinScore API'],
    ['email',     'ZeptoMail'],
    ['stage',     'Stage Transition'],
    ['verifier',  'Verifier'],
    ['ci',        'CI Officer'],
    ['approver',  'Approver'],
    ['encoder',   'Encoder'],
    ['loandisk',  'Loandisk'],
    ['so',        'SO Confirmation'],
    ['decline',   'Decline / Reject'],
    ['decision',  'Decision'],
  ];
  const x = 40, y = 40;
  const itemH = 34;
  const w = 320;
  const h = 30 + items.length * itemH + 16;
  let out = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="#ffffff" stroke="#495057" stroke-width="2"/>`;
  out += `<text x="${x + 16}" y="${y + 28}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="18" font-weight="700" fill="#1a1a1a">Legend — Actor</text>`;
  items.forEach((it, i) => {
    const iy = y + 50 + i * itemH;
    const c = C[it[0]];
    out += `<rect x="${x + 16}" y="${iy - 16}" width="26" height="20" rx="4" fill="${c.bg}" stroke="${c.stroke}" stroke-width="2"/>`;
    out += `<text x="${x + 52}" y="${iy}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="15" fill="#212529">${esc(it[1])}</text>`;
  });
  return out;
}

function renderTitle() {
  const x = CANVAS_W / 2;
  const y = 62;
  let out = `<text x="${x}" y="${y}" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="34" font-weight="800" fill="#0b2545">GR8 Lending — Customer Journey (Full Ops)</text>`;
  out += `<text x="${x}" y="${y + 32}" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="17" fill="#495057">Intake  →  Pipeline stages  →  Scoring  →  Loandisk  (incl. declines, returns, SO confirmation)</text>`;
  return out;
}

function buildSVG() {
  const defs = `
<defs>
  <marker id="ah" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="10" markerHeight="10" orient="auto-start-reverse">
    <path d="M 0 0 L 12 6 L 0 12 Z" fill="#212529"/>
  </marker>
</defs>`;
  let body = '';
  body += renderTitle();
  body += renderLegend();
  ARROWS.forEach(a => { body += renderArrow(a); });
  Object.keys(NODES).forEach(id => { body += renderNode(id); });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}" width="${CANVAS_W}" height="${CANVAS_H}">
  <rect x="0" y="0" width="${CANVAS_W}" height="${CANVAS_H}" fill="#fafbfc"/>
  ${defs}
  ${body}
</svg>`;
}

// ---------- Excalidraw JSON ----------
let seedCounter = 10000;
function seed() { return ++seedCounter; }

function exRect(id, p, actor, label) {
  const c = C[actor];
  return {
    id,
    type: 'rectangle',
    x: p.cx - p.w/2,
    y: p.cy - p.h/2,
    width: p.w,
    height: p.h,
    angle: 0,
    strokeColor: c.stroke,
    backgroundColor: c.bg,
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 3 },
    seed: seed(),
    version: 1,
    versionNonce: seed(),
    isDeleted: false,
    boundElements: label ? [{ type: 'text', id: id + '-t' }] : [],
    updated: 1,
    link: null,
    locked: false,
  };
}

function exDiamond(id, p, actor, label) {
  const c = C[actor];
  return {
    id,
    type: 'diamond',
    x: p.cx - p.w/2,
    y: p.cy - p.h/2,
    width: p.w,
    height: p.h,
    angle: 0,
    strokeColor: c.stroke,
    backgroundColor: c.bg,
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 2 },
    seed: seed(),
    version: 1,
    versionNonce: seed(),
    isDeleted: false,
    boundElements: label ? [{ type: 'text', id: id + '-t' }] : [],
    updated: 1,
    link: null,
    locked: false,
  };
}

function exText(id, containerId, p, text, size = 18) {
  return {
    id,
    type: 'text',
    x: p.cx - p.w/2 + 10,
    y: p.cy - p.h/2 + 10,
    width: p.w - 20,
    height: p.h - 20,
    angle: 0,
    strokeColor: '#1a1a1a',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: seed(),
    version: 1,
    versionNonce: seed(),
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    fontSize: size,
    fontFamily: 1,
    text,
    textAlign: 'center',
    verticalAlign: 'middle',
    containerId,
    originalText: text,
    lineHeight: 1.25,
    baseline: 15,
  };
}

function exArrow(id, a) {
  const pFrom = pos[a.from], pTo = pos[a.to];
  const stroke = '#212529';
  let sx, sy, ex, ey, points;
  if (a.side === 'right') {
    sx = pFrom.cx + pFrom.w/2; sy = pFrom.cy;
    ex = pTo.cx - pTo.w/2;     ey = pTo.cy;
    points = [[0,0], [ex - sx, ey - sy]];
  } else if (a.side === 'returnLeft') {
    sx = pFrom.cx - pFrom.w/2; sy = pFrom.cy;
    ex = pTo.cx - pTo.w/2;     ey = pTo.cy;
    const bend = Math.min(sx, ex) - 140;
    points = [[0,0], [bend - sx, 0], [bend - sx, ey - sy], [ex - sx, ey - sy]];
  } else if (a.side === 'sideIn') {
    sx = pFrom.cx - pFrom.w/2; sy = pFrom.cy;
    ex = pTo.cx + pTo.w/2;     ey = pTo.cy;
    const bendX = ex + 80;
    points = [[0,0], [bendX - sx, 0], [bendX - sx, ey - sy], [ex - sx, ey - sy]];
  } else {
    sx = pFrom.cx; sy = pFrom.cy + pFrom.h/2;
    ex = pTo.cx;   ey = pTo.cy - pTo.h/2;
    points = [[0,0], [ex - sx, ey - sy]];
  }
  return {
    id,
    type: 'arrow',
    x: sx,
    y: sy,
    width: Math.abs(ex - sx),
    height: Math.abs(ey - sy),
    angle: 0,
    strokeColor: stroke,
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: a.dashed ? 'dashed' : 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 2 },
    seed: seed(),
    version: 1,
    versionNonce: seed(),
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    startBinding: { elementId: a.from, focus: 0, gap: 8 },
    endBinding: { elementId: a.to, focus: 0, gap: 8 },
    lastCommittedPoint: null,
    startArrowhead: null,
    endArrowhead: 'arrow',
    points,
  };
}

function buildExcalidraw() {
  const elements = [];
  Object.keys(NODES).forEach(id => {
    const n = NODES[id];
    const p = pos[id];
    const labelText = n.sub ? `${n.title}\n${n.sub}` : n.title;
    const size = n.shape === 'diamond' ? 18 : 18;
    if (n.shape === 'diamond') elements.push(exDiamond(id, p, n.actor, true));
    else elements.push(exRect(id, p, n.actor, true));
    elements.push(exText(id + '-t', id, p, labelText, size));
  });
  ARROWS.forEach((a, i) => elements.push(exArrow('a' + i, a)));
  return {
    type: 'excalidraw',
    version: 2,
    source: 'https://excalidraw.com',
    elements,
    appState: {
      gridSize: null,
      viewBackgroundColor: '#fafbfc',
    },
    files: {},
  };
}

// ---------- write outputs ----------
async function main() {
  const svg = buildSVG();
  const svgPath = path.join(OUT_DIR, 'customer-journey.svg');
  fs.writeFileSync(svgPath, svg);

  const exc = buildExcalidraw();
  const excPath = path.join(OUT_DIR, 'customer-journey.excalidraw');
  fs.writeFileSync(excPath, JSON.stringify(exc, null, 2));

  const pngPath = path.join(OUT_DIR, 'customer-journey.png');
  await sharp(Buffer.from(svg), { density: 200 })
    .resize({ width: CANVAS_W * 2 })
    .png({ compressionLevel: 9 })
    .toFile(pngPath);

  console.log('[ok]', svgPath);
  console.log('[ok]', excPath);
  console.log('[ok]', pngPath);
}

main().catch(err => { console.error(err); process.exit(1); });
