// node --test tests/viewer3d/anatomy.test.mjs — catalog anatomy & procedural body invariants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBody, polygonize, snapPoint } from '../../web/js/viewer3d/body-sdf.js';
import { regionAt } from '../../web/js/viewer3d/regions.js';
import { buildInstances, resolveInstance } from '../../web/js/viewer3d/viewer-common.js';

const cat = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'catalog');
const anatomy = JSON.parse(readFileSync(join(cat, 'point-anatomy.json'), 'utf8'));
const regions = JSON.parse(readFileSync(join(cat, 'regions.json'), 'utf8'));
const entries = Object.entries(anatomy).filter(([k]) => k !== 'subpoints');
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const VIEWS = new Set(['anterior', 'posterior', 'lateral', 'superior', 'inferior', 'internal']);
const body = buildBody({ sex: 'neutral' });

test('regions.json: unique ids, localized names, valid parents', () => {
  const ids = new Set(regions.map((r) => r.id));
  assert.equal(ids.size, regions.length);
  for (const r of regions) {
    assert.ok(r.name.es && r.name.en, r.id);
    assert.ok(r.parent === null || ids.has(r.parent), r.id);
  }
  for (const id of ['head', 'face', 'neck', 'thorax', 'abdomen', 'pelvis', 'upper-back', 'lower-back', 'arm', 'forearm', 'hand', 'thigh', 'knee', 'leg', 'foot']) assert.ok(ids.has(id), id);
});

test('point-anatomy.json: CONTRACT §4.3 shape, slug ids, known regions/views', () => {
  const regionIds = new Set(regions.map((r) => r.id));
  assert.ok(entries.length > 250);
  for (const [id, a] of entries) {
    assert.equal(id, slug(id), id);
    assert.ok(regionIds.has(a.region), `${id}: region ${a.region}`);
    assert.ok(VIEWS.has(a.view), `${id}: view ${a.view}`);
    for (const k of ['x', 'y', 'z']) assert.equal(typeof a.pos[k], 'number', `${id}.${k}`);
    assert.ok(a.pos.y >= -0.01 && a.pos.y <= 1.76, `${id}: y in body range`);
  }
});

test('surface points lie on the neutral mannequin skin (≤ 2 mm)', () => {
  for (const [id, a] of entries) {
    if (a.view === 'internal') { assert.ok(body.sdf(a.pos.x, a.pos.y, a.pos.z) < 0, `${id} internal point inside body`); continue; }
    const d = Math.abs(body.sdf(a.pos.x, a.pos.y, a.pos.z));
    assert.ok(d < 0.002, `${id}: ${(d * 1000).toFixed(1)} mm off the skin`);
  }
});

test('bilateral points are authored on the patient RIGHT (x<0) when points.json exists', () => {
  const pj = join(cat, 'points.json');
  if (!existsSync(pj)) return;
  const points = JSON.parse(readFileSync(pj, 'utf8'));
  for (const p of points) {
    const a = anatomy[p.id];
    assert.ok(a, `missing anatomy: ${p.id}`);
    if (p.laterality === 'bilateral') assert.ok(a.pos.x < 0, `${p.id}: x=${a.pos.x}`);
  }
});

test('re-snapping catalog positions is stable (idempotent)', () => {
  for (const [id, a] of entries.slice(0, 120)) {
    if (a.view === 'internal') continue;
    const r = snapPoint(body.sdf, [a.pos.x, a.pos.y, a.pos.z], a.view);
    const d = Math.hypot(r.pos[0] - a.pos.x, r.pos[1] - a.pos.y, r.pos[2] - a.pos.z);
    assert.ok(d < 0.003, `${id}: moved ${(d * 1000).toFixed(1)} mm`);
  }
});

test('key clinical placements resolve to the expected body zone', () => {
  const expect = { timo: 'thorax', ombligo: 'abdomen', estomago: 'abdomen', rinon: 'lower-back', popliteo: 'knee', gastrocnemio: 'leg', ciatico: 'thigh', palma: 'hand', hipofisis: 'face' };
  for (const [id, region] of Object.entries(expect)) {
    const p = anatomy[id].pos;
    assert.equal(regionAt([p.x, p.y, p.z]).regionId, region, id);
  }
  assert.ok(anatomy.higado.pos.x < 0, 'liver on the patient right');
  assert.ok(anatomy.corazon.pos.x > 0, 'heart on the patient left');
  assert.ok(anatomy.rinon.pos.z < 0 && anatomy.timo.pos.z > 0, 'kidney posterior, thymus anterior');
});

test('instances: bilateral R/L mirrored, central single; resolveInstance fallbacks', () => {
  const inst = buildInstances([{ id: 'rinon', laterality: 'bilateral', view: 'posterior', pos: { x: -0.06, y: 1.1, z: -0.09 } }, { id: 'timo', laterality: 'central', view: 'anterior', pos: { x: 0, y: 1.39, z: 0.08 } }]);
  assert.equal(inst.length, 3);
  const by = new Map(inst.map((i) => [i.key, i]));
  assert.equal(by.get('rinon|L').pos.x, 0.06);
  assert.equal(resolveInstance(by, 'timo', 'R').key, 'timo|C');
  assert.equal(resolveInstance(by, 'rinon', 'RL').key, 'rinon|R');
});

test('sex presets mesh into a closed, plausible body', () => {
  for (const sex of ['neutral', 'female', 'male']) {
    const b = buildBody({ sex });
    const m = polygonize(b.sdf, { bounds: b.bounds, h: 0.012 });
    let ymax = -1, ymin = 9;
    for (let i = 1; i < m.positions.length; i += 3) { ymax = Math.max(ymax, m.positions[i]); ymin = Math.min(ymin, m.positions[i]); }
    assert.ok(ymax > 1.72 && ymax < 1.78, `${sex} height ${ymax}`);
    assert.ok(ymin < 0.01, `${sex} feet on the ground`);
    assert.ok(m.indices.length > 10000);
  }
});
