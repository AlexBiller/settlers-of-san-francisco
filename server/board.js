'use strict';

const RESOURCES = ['redwood', 'brick', 'sourdough', 'coffee', 'chips'];

const TILE_INFO = {
  redwood: { name: 'Redwood', place: 'The Presidio' },
  brick: { name: 'Bricks', place: 'The Painted Ladies' },
  sourdough: { name: 'Sourdough', place: "Fisherman's Wharf" },
  coffee: { name: 'Coffee', place: 'North Beach' },
  chips: { name: 'Microchips', place: 'SoMa' },
  bay: { name: 'Open Bay', place: "Karl the Fog's home" },
};

const TILE_POOL = [
  ...Array(4).fill('redwood'),
  ...Array(4).fill('sourdough'),
  ...Array(4).fill('coffee'),
  ...Array(3).fill('brick'),
  ...Array(3).fill('chips'),
  'bay',
];

const NUMBER_POOL = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];
const HARBOR_POOL = ['any', 'any', 'any', 'any', ...RESOURCES];
const HARBOR_SPACING = [3, 3, 4, 3, 3, 4, 3, 3, 4];

function pips(n) {
  if (!n) return 0;
  return 6 - Math.abs(7 - n);
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function key(x, y) {
  return `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
}

function buildGeometry() {
  const hexes = [];
  for (let r = -2; r <= 2; r++) {
    for (let q = Math.max(-2, -r - 2); q <= Math.min(2, -r + 2); q++) {
      hexes.push({ id: hexes.length, q, r, x: Math.sqrt(3) * (q + r / 2), y: 1.5 * r });
    }
  }
  const vertices = [];
  const vIndex = new Map();
  const edges = [];
  const eIndex = new Map();
  for (const h of hexes) {
    h.vertices = [];
    for (let i = 0; i < 6; i++) {
      const ang = (Math.PI / 180) * (60 * i - 30);
      const x = h.x + Math.cos(ang);
      const y = h.y + Math.sin(ang);
      const k = key(x, y);
      let v = vIndex.get(k);
      if (v === undefined) {
        v = vertices.length;
        vIndex.set(k, v);
        vertices.push({ id: v, x: +x.toFixed(4), y: +y.toFixed(4), hexes: [], adj: [], edges: [] });
      }
      vertices[v].hexes.push(h.id);
      h.vertices.push(v);
    }
    for (let i = 0; i < 6; i++) {
      const a = h.vertices[i];
      const b = h.vertices[(i + 1) % 6];
      const k = a < b ? `${a}-${b}` : `${b}-${a}`;
      let e = eIndex.get(k);
      if (e === undefined) {
        e = edges.length;
        eIndex.set(k, e);
        edges.push({ id: e, v: [Math.min(a, b), Math.max(a, b)], hexes: [] });
        vertices[a].adj.push(b);
        vertices[b].adj.push(a);
        vertices[a].edges.push(e);
        vertices[b].edges.push(e);
      }
      edges[e].hexes.push(h.id);
    }
  }
  return { hexes, vertices, edges };
}

function numbersValid(hexes) {
  for (const h of hexes) {
    if (h.num !== 6 && h.num !== 8) continue;
    for (const o of hexes) {
      if (o === h || (o.num !== 6 && o.num !== 8)) continue;
      const dq = h.q - o.q;
      const dr = h.r - o.r;
      if (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr) === 2) return false;
    }
  }
  return true;
}

function generateBoard(rng = Math.random) {
  const { hexes, vertices, edges } = buildGeometry();
  const tiles = shuffle(TILE_POOL, rng);
  hexes.forEach((h, i) => { h.res = tiles[i]; h.num = null; });
  const land = hexes.filter((h) => h.res !== 'bay');
  for (let tries = 0; tries < 5000; tries++) {
    const nums = shuffle(NUMBER_POOL, rng);
    land.forEach((h, i) => { h.num = nums[i]; });
    if (numbersValid(hexes)) break;
  }

  const coastal = edges.filter((e) => e.hexes.length === 1);
  const mid = (e) => {
    const a = vertices[e.v[0]];
    const b = vertices[e.v[1]];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  coastal.sort((e1, e2) => {
    const m1 = mid(e1);
    const m2 = mid(e2);
    return Math.atan2(m1.y, m1.x) - Math.atan2(m2.y, m2.x);
  });
  const types = shuffle(HARBOR_POOL, rng);
  const harbors = [];
  let idx = Math.floor(rng() * 3);
  HARBOR_SPACING.forEach((step, i) => {
    const e = coastal[idx % coastal.length];
    const m = mid(e);
    const len = Math.hypot(m.x, m.y) || 1;
    harbors.push({ edge: e.id, vertices: e.v.slice(), type: types[i], x: +(m.x + (m.x / len) * 0.55).toFixed(4), y: +(m.y + (m.y / len) * 0.55).toFixed(4) });
    idx += step;
  });
  for (const v of vertices) v.harbor = null;
  for (const hb of harbors) for (const v of hb.vertices) vertices[v].harbor = hb.type;

  const fogHex = hexes.find((h) => h.res === 'bay').id;
  return { hexes, vertices, edges, harbors, fogHex };
}

module.exports = { RESOURCES, TILE_INFO, pips, shuffle, generateBoard, buildGeometry };
