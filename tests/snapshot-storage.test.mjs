import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_PART_BYTES, packSnapshot, unpackSnapshot, snapshotPartFiles, fetchSharedSnapshot } from '../snapshot-storage.js';
import { canReplaceSnapshot } from '../snapshot-state.js';
import { readStoredSnapshot, writeStoredSnapshot } from '../scripts/snapshot-files.mjs';
import { buildSite } from '../scripts/build-site.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const canonical = value => JSON.parse(JSON.stringify(value));
function sample(generatedAt = '2026-10-18T07:00:00Z', label = 'শ্বপ্ন 😀 café') {
  const row = { OutletCode: 'F001', ArticleCode: '00012', ArticleName: label,
    Quantity: 2.125, Amount: -5.75, UnitPrice: 0, Benchmark: null, Empty: '', Missing: undefined };
  const mode = { scope: { start: '2026-10-01', end: '2026-10-17', masterCategories: ['LOOSE COMMODITY'], deviationFloor: 5, qtyFloor: 2 },
    summary: { Incidents: 1, UnitPrice: 12.125 }, detail: [row], supplemental: [{ ...row, Date: '2026-10-17', Quantity: 4 }], trend: [] };
  return { version: 1, generatedAt, sourceTimestamp: '2026-10-17T12:00:00Z', sourceReport: 'https://example.test/pricing',
    metadataFingerprint: 'unchanged-marker', dataFingerprint: 'unchanged-data',
    organization: { rows: [{ OutletCode: 'F001', RHO: 'RHO', Zonal: 'Zonal' }] },
    dimensions: { articles: [{ ArticleCode: '00012', ArticleName: label }], outlets: [{ OutletCode: 'F001' }] },
    modes: { buy: structuredClone(mode), sale: structuredClone(mode) } };
}
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pricing-snapshot-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const partReader = parts => {
  const files = new Map(parts.map(part => [part.file, part.content]));
  return async file => {
    if (!files.has(file)) throw new Error('Missing part');
    return files.get(file);
  };
};

test('Existing single-file snapshots still load without requesting any parts', async () => {
  const legacy = canonical(sample());
  assert.deepEqual(await unpackSnapshot(legacy, () => { throw new Error('Unexpected request'); }), legacy);
  const calls = [];
  const loaded = await fetchSharedSnapshot(async (url, options) => {
    calls.push(url); assert.equal(options.cache, 'no-store');
    return { ok: true, json: async () => legacy };
  });
  assert.deepEqual(loaded, legacy); assert.equal(calls.length, 1);
});

test('Parts preserve all records, Unicode across byte boundaries, exact numbers and metadata', async () => {
  const original = sample();
  original.modes.sale.supplemental = Array.from({ length: 150 }, (_, i) => ({ ...original.modes.sale.supplemental[0], ArticleCode: String(i).padStart(8, '0') }));
  const packed = await packSnapshot(original, 127);
  assert.ok(packed.parts.length > 1);
  assert.ok(packed.parts.every(part => part.bytes <= 127));
  assert.deepEqual(await unpackSnapshot(packed.index, partReader(packed.parts)), canonical(original));
  assert.equal(packed.index.byteLength, Buffer.byteLength(JSON.stringify(original)));
});

test('Missing, truncated, changed, or reordered parts cannot be accepted', async () => {
  const { index, parts } = await packSnapshot(sample(), 256);
  const read = partReader(parts);
  await assert.rejects(unpackSnapshot(index, async file => { if (file === parts[0].file) throw new Error('Missing part'); return read(file); }), /Missing part/);
  await assert.rejects(unpackSnapshot(index, async file => file === parts[0].file ? parts[0].content.subarray(1) : read(file)), /incomplete or corrupted/);
  await assert.rejects(unpackSnapshot(index, async file => {
    const bytes = new Uint8Array(await read(file)); if (file === parts[0].file) bytes[0] ^= 1; return bytes;
  }), /incomplete or corrupted/);
  await assert.rejects(unpackSnapshot({ ...index, parts: [...index.parts].reverse() }, read), /do not match/);
  await assert.rejects(unpackSnapshot({ ...index, generatedAt: '2026-10-19T00:00:00Z' }, read), /different update/);
});

test('Invalid indexes and unsafe paths are rejected before a part is requested', async () => {
  const { index, parts } = await packSnapshot(sample(), 256);
  let requests = 0;
  const read = async () => { requests++; return parts[0].content; };
  await assert.rejects(unpackSnapshot({ ...index, byteLength: index.byteLength + 1 }, read), /incomplete/);
  await assert.rejects(unpackSnapshot({ ...index, parts: [{ ...index.parts[0], file: '../snapshot.json' }] }, read), /invalid data part/);
  await assert.rejects(unpackSnapshot({ ...index, parts: [{ ...index.parts[0], bytes: SNAPSHOT_PART_BYTES + 1 }] }, read), /invalid data part/);
  await assert.rejects(unpackSnapshot({ storageFormat: 'unknown' }, read), /not supported/);
  assert.equal(requests, 0);
});

test('Browser loader reads every part with bounded concurrency and reports HTTP failures', async () => {
  const original = sample();
  const { index, parts } = await packSnapshot(original, 128);
  const files = new Map(parts.map(part => [part.file, part.content]));
  let active = 0, peak = 0, reads = 0;
  const loaded = await fetchSharedSnapshot(async (url, options) => {
    assert.equal(options.cache, 'no-store');
    const file = url.replace(/^\.\//, '').split('?')[0];
    if (file === 'snapshot.json') return { ok: true, json: async () => index };
    reads++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return { ok: true, arrayBuffer: async () => files.get(file) };
  });
  assert.deepEqual(loaded, canonical(original)); assert.equal(reads, index.parts.length); assert.ok(peak <= 4);
  await assert.rejects(fetchSharedSnapshot(async () => ({ ok: false, status: 503 })), /503/);
  await assert.rejects(fetchSharedSnapshot(async url => url.includes('snapshot.json')
    ? { ok: true, json: async () => index } : { ok: false, status: 404 }), /404/);
});

test('Older multipart snapshots still obey the existing replacement safeguards', async () => {
  const current = canonical(sample('2026-10-18T08:00:00Z'));
  const packed = await packSnapshot(sample('2026-10-18T07:00:00Z'), 256);
  assert.equal(canReplaceSnapshot(await unpackSnapshot(packed.index, partReader(packed.parts)), current), false);
});

test('Disk writer migrates legacy data, retains the previous parts, and cleans older parts', async t => {
  const root = await temporary(t);
  const first = sample();
  await fs.writeFile(path.join(root, 'snapshot.json'), JSON.stringify(first));
  assert.deepEqual(await readStoredSnapshot(root), canonical(first));
  const firstIndex = await writeStoredSnapshot(root, first, 256);
  const second = sample('2026-10-18T08:00:00Z', 'Second update');
  const secondIndex = await writeStoredSnapshot(root, second, 256);
  for (const file of snapshotPartFiles(firstIndex)) await fs.access(path.join(root, file));
  const third = sample('2026-10-18T09:00:00Z', 'Third update');
  const thirdIndex = await writeStoredSnapshot(root, third, 256);
  const retained = snapshotPartFiles(thirdIndex, true).sort();
  const disk = (await fs.readdir(path.join(root, 'snapshot-parts'))).map(file => 'snapshot-parts/' + file).sort();
  assert.deepEqual(disk, retained);
  for (const file of snapshotPartFiles(secondIndex)) await fs.access(path.join(root, file));
  assert.deepEqual(await readStoredSnapshot(root), canonical(third));
});

test('A failed part write leaves the previously published snapshot unchanged', async t => {
  const root = await temporary(t);
  const original = sample();
  await writeStoredSnapshot(root, original, 256);
  const oldIndex = await fs.readFile(path.join(root, 'snapshot.json'), 'utf8');
  const next = sample('2026-10-18T08:00:00Z', 'A new snapshot');
  const packed = await packSnapshot(next, 256);
  await fs.mkdir(path.join(root, packed.parts[0].file));
  await assert.rejects(writeStoredSnapshot(root, next, 256));
  assert.equal(await fs.readFile(path.join(root, 'snapshot.json'), 'utf8'), oldIndex);
  assert.deepEqual(await readStoredSnapshot(root), canonical(original));
});

test('Pages build includes current and retained parts and rejects incomplete data', async t => {
  const root = await temporary(t);
  for (const name of ['index.html','styles.css','app.js','settings.js','powerbi.js','organization.js','data.js','snapshot-state.js','snapshot-storage.js','export.js','xlsx-lite.js','number-details.js','.nojekyll']) {
    await fs.copyFile(path.join(project, name), path.join(root, name));
  }
  await fs.writeFile(path.join(root, 'snapshot-status.json'), '{}');
  await writeStoredSnapshot(root, sample(), 256);
  const next = sample('2026-10-18T08:00:00Z', 'Build update');
  const index = await writeStoredSnapshot(root, next, 256);
  await buildSite(root);
  assert.deepEqual(await readStoredSnapshot(path.join(root, '_site')), canonical(next));
  for (const file of snapshotPartFiles(index, true)) await fs.access(path.join(root, '_site', file));
  await fs.rm(path.join(root, index.parts[0].file));
  await assert.rejects(buildSite(root), /ENOENT/);
  assert.deepEqual(await readStoredSnapshot(path.join(root, '_site')), canonical(next));
});
