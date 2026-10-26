import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_PART_BYTES, packSnapshot, packRecordSnapshot, unpackSnapshot, snapshotPartFiles, fetchSharedSnapshot } from '../snapshot-storage.js';
import { canReplaceSnapshot } from '../snapshot-state.js';
import { readStoredSnapshot, readStoredSnapshotMetadata, writeStoredSnapshot } from '../scripts/snapshot-files.mjs';
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
  const packed = await packRecordSnapshot(next, 256);
  const prior = new Set(snapshotPartFiles(JSON.parse(oldIndex)));
  const changed = packed.parts.find(part => !prior.has(part.file));
  assert.ok(changed);
  await fs.mkdir(path.join(root, changed.file));
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

test('Record batches preserve every field, row order, nested value and exact number without serializing the full snapshot', async () => {
  const original = sample();
  const rows = Array.from({ length: 75 }, (_, i) => ({ ...original.modes.sale.detail[0],
    ArticleCode: String(i).padStart(9, '0'), Nested: [null, undefined, 'a\\b\n"😀', { value: -0 }],
    Quantity: i / 8, Amount: -1234567890.125, Optional: undefined }));
  original.modes.sale.supplemental = rows;
  original.dimensions.extra = { empty: [], nested: [1, null, false, ['one', 'two']] };
  const expected = canonical(original);
  const stringify = JSON.stringify;
  const guarded = new Set([original, original.modes, original.modes.sale, rows]);
  JSON.stringify = function(value, ...args) {
    assert.equal(guarded.has(value), false, 'A full snapshot or dataset must not be stringified');
    return stringify(value, ...args);
  };
  try {
    const { index, parts } = await packRecordSnapshot(original, 1024);
    assert.equal(index.storageFormat, 'shwapno-pricing-snapshot-records-v2');
    assert.ok(parts.length > 10);
    assert.ok(parts.every(part => part.bytes <= 1024 && part.rawBytes <= 1024));
    assert.ok(parts.some(part => part.encoding === 'gzip'));
    assert.deepEqual(await unpackSnapshot(index, partReader(parts)), expected);
  } finally { JSON.stringify = stringify; }
});

test('Record format rejects missing, truncated, corrupted, reordered and altered metadata or row counts', async () => {
  const original = sample();
  original.modes.sale.supplemental = Array.from({ length: 30 }, (_, i) => ({ ...original.modes.sale.detail[0], ArticleCode: String(i) }));
  const { index, parts } = await packRecordSnapshot(original, 512);
  const read = partReader(parts);
  await assert.rejects(unpackSnapshot(index, async () => { throw new Error('Missing batch'); }), /Missing batch/);
  await assert.rejects(unpackSnapshot(index, async file => (await read(file)).subarray(1)), /incomplete or corrupted/);
  await assert.rejects(unpackSnapshot(index, async file => {
    const content = new Uint8Array(await read(file)); content[0] ^= 1; return content;
  }), /incomplete or corrupted/);
  await assert.rejects(unpackSnapshot({ ...index, parts: [...index.parts].reverse() }, read), /do not match|incomplete/);
  const changed = structuredClone(index);
  changed.snapshot.modes.sale.scope.qtyFloor = 0;
  await assert.rejects(unpackSnapshot(changed, read), /do not match/);
  const shortened = structuredClone(index);
  shortened.arrays.at(-1).length++;
  await assert.rejects(unpackSnapshot(shortened, read), /incomplete/);
  let requests = 0;
  const unsafe = structuredClone(index);
  unsafe.arrays[0].path = ['constructor', 'prototype', 'rows'];
  await assert.rejects(unpackSnapshot(unsafe, async () => { requests++; }), /invalid array path/);
  assert.equal(requests, 0);
});

test('Record batch row counts, encoding, decompressed sizes and source metadata are verified after integrity checks', async () => {
  const { index, parts } = await packRecordSnapshot(sample(), 512);
  const read = partReader(parts);
  async function resign(value) {
    const { sha256, retainedParts, ...document } = value;
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(document)));
    value.sha256 = Buffer.from(hash).toString('hex');
    return value;
  }
  const expanded = structuredClone(index);
  expanded.parts[0].rawBytes++;
  await assert.rejects(unpackSnapshot(await resign(expanded), read), /incomplete or corrupted/);
  const wrongCount = structuredClone(index);
  wrongCount.parts[0].records++;
  wrongCount.arrays[0].length++;
  await assert.rejects(unpackSnapshot(await resign(wrongCount), read), /incomplete/);
  const wrongEncoding = structuredClone(index);
  wrongEncoding.parts[0].encoding = 'unknown';
  await assert.rejects(unpackSnapshot(wrongEncoding, read), /invalid data part/);
  const differentUpdate = structuredClone(index);
  differentUpdate.generatedAt = '2026-10-19T00:00:00Z';
  await assert.rejects(unpackSnapshot(await resign(differentUpdate), read), /different update/);
});

test('Browser record loader preserves source calculations with four concurrent reads and fails on a missing batch', async () => {
  const original = sample();
  original.modes.sale.supplemental = Array.from({ length: 50 }, (_, i) => ({ ...original.modes.sale.detail[0], ArticleCode: String(i) }));
  const { index, parts } = await packRecordSnapshot(original, 512);
  const read = partReader(parts);
  let active = 0, peak = 0, reads = 0;
  const loaded = await fetchSharedSnapshot(async url => {
    const file = url.replace(/^\.\//, '').split('?')[0];
    if (file === 'snapshot.json') return { ok: true, json: async () => index };
    active++; reads++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve)); active--;
    return { ok: true, arrayBuffer: () => read(file) };
  });
  assert.deepEqual(loaded, canonical(original));
  assert.equal(reads, parts.length);
  assert.ok(peak <= 4);
  await assert.rejects(fetchSharedSnapshot(async url => url.includes('snapshot.json')
    ? { ok: true, json: async () => index } : { ok: false, status: 404 }), /404/);
  const older = sample('2026-10-17T08:00:00Z');
  assert.equal(canReplaceSnapshot(older, loaded), false);
});

test('A byte-split snapshot migrates to record batches while retaining every prior file and value', async t => {
  const root = await temporary(t);
  const old = sample();
  const legacy = await packSnapshot(old, 256);
  await fs.mkdir(path.join(root, 'snapshot-parts'));
  for (const part of legacy.parts) await fs.writeFile(path.join(root, part.file), part.content);
  await fs.writeFile(path.join(root, 'snapshot.json'), JSON.stringify(legacy.index));
  const next = sample('2026-10-18T08:00:00Z');
  const index = await writeStoredSnapshot(root, next, 512);
  assert.deepEqual(await readStoredSnapshot(root), canonical(next));
  for (const file of snapshotPartFiles(legacy.index)) assert.ok(snapshotPartFiles(index, true).includes(file));
  assert.deepEqual(await unpackSnapshot(legacy.index, file => fs.readFile(path.join(root, file))), canonical(old));
});

test('An oversized or invalid row never replaces the last valid snapshot', async t => {
  const root = await temporary(t);
  await writeStoredSnapshot(root, sample(), 512);
  const before = await fs.readFile(path.join(root, 'snapshot.json'), 'utf8');
  const next = sample('2026-10-18T08:00:00Z');
  next.modes.sale.detail[0].ArticleName = 'x'.repeat(1024);
  await assert.rejects(writeStoredSnapshot(root, next, 512), /record exceeds/);
  assert.equal(await fs.readFile(path.join(root, 'snapshot.json'), 'utf8'), before);
  assert.deepEqual(await readStoredSnapshot(root), canonical(sample()));
});

test('Update metadata releases old datasets after full validation and preserves all replacement decisions', async t => {
  const root = await temporary(t);
  const current = sample();
  current.organization.updatedAt = '2026-10-18T06:00:00Z';
  const index = await writeStoredSnapshot(root, current, 512);
  const metadata = await readStoredSnapshotMetadata(root);
  assert.deepEqual({ generatedAt: metadata.generatedAt, sourceTimestamp: metadata.sourceTimestamp,
    sourceReport: metadata.sourceReport, metadataFingerprint: metadata.metadataFingerprint,
    dataFingerprint: metadata.dataFingerprint, organization: metadata.organization, modes: metadata.modes },
  { generatedAt: current.generatedAt, sourceTimestamp: current.sourceTimestamp,
    sourceReport: current.sourceReport, metadataFingerprint: current.metadataFingerprint,
    dataFingerprint: current.dataFingerprint, organization: { updatedAt: current.organization.updatedAt },
    modes: { buy: { scope: current.modes.buy.scope }, sale: { scope: current.modes.sale.scope } } });
  const candidates = [sample('2026-10-18T08:00:00Z'), sample('2026-10-18T06:00:00Z'),
    { ...sample('2026-10-18T08:00:00Z'), sourceTimestamp: '2026-10-16T00:00:00Z' }];
  const shorterWindow = sample('2026-10-18T08:00:00Z');
  shorterWindow.modes.sale.scope.end = '2026-10-16'; candidates.push(shorterWindow);
  for (const candidate of candidates) {
    assert.equal(canReplaceSnapshot(candidate, metadata), canReplaceSnapshot(candidate, current));
  }
  await fs.rm(path.join(root, index.parts[0].file));
  await assert.rejects(readStoredSnapshotMetadata(root), /ENOENT/);
});
