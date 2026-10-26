import { validateSnapshot } from './snapshot-state.js';

export const SNAPSHOT_PART_BYTES = 8 * 1024 * 1024;
const FORMAT = 'shwapno-pricing-snapshot-parts-v1';
const RECORD_FORMAT = 'shwapno-pricing-snapshot-records-v2';
const PART_FILE = /^snapshot-parts\/[a-f0-9]{64}\.part$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function isMultipartSnapshot(value) {
  return value?.storageFormat === FORMAT || value?.storageFormat === RECORD_FORMAT;
}

async function digest(bytes) {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
}

function validateIndex(value) {
  if (!isMultipartSnapshot(value) || value.version !== 1 || !value.generatedAt || !value.sourceReport
    || !Number.isSafeInteger(value.byteLength) || value.byteLength < 1 || !SHA256.test(value.sha256)
    || !Array.isArray(value.parts) || !value.parts.length) {
    throw new Error('The shared snapshot index is incomplete.');
  }
  let bytes = 0;
  for (const part of value.parts) {
    if (!part || !PART_FILE.test(part.file) || !SHA256.test(part.sha256)
      || part.file !== `snapshot-parts/${part.sha256}.part`
      || !Number.isSafeInteger(part.bytes) || part.bytes < 1 || part.bytes > SNAPSHOT_PART_BYTES) {
      throw new Error('The shared snapshot has an invalid data part.');
    }
    bytes += part.bytes;
  }
  if (!Number.isSafeInteger(bytes) || bytes !== value.byteLength
    || (value.retainedParts !== undefined && (!Array.isArray(value.retainedParts)
      || value.retainedParts.some(file => !PART_FILE.test(file))))) {
    throw new Error('The shared snapshot parts are incomplete.');
  }
  if (value.storageFormat === RECORD_FORMAT) validateRecordIndex(value);
  return value;
}

function arrayTarget(snapshot, keys) {
  if (!Array.isArray(keys) || !keys.length || keys.some(key => typeof key !== 'string')) {
    throw new Error('The shared snapshot has an invalid array path.');
  }
  let parent = snapshot;
  for (const key of keys.slice(0, -1)) {
    if (!parent || typeof parent !== 'object' || Array.isArray(parent) || !Object.hasOwn(parent, key)) {
      throw new Error('The shared snapshot has an invalid array path.');
    }
    parent = parent[key];
  }
  const key = keys.at(-1);
  if (!parent || typeof parent !== 'object' || Array.isArray(parent) || !Object.hasOwn(parent, key)
    || !Array.isArray(parent[key]) || parent[key].length) {
    throw new Error('The shared snapshot has an invalid array path.');
  }
  return { parent, key };
}

function validateRecordIndex(index) {
  if (!index.snapshot || typeof index.snapshot !== 'object' || Array.isArray(index.snapshot)
    || !Array.isArray(index.arrays)) throw new Error('The shared snapshot index is incomplete.');
  const paths = new Set();
  let next = 0;
  for (const array of index.arrays) {
    arrayTarget(index.snapshot, array?.path);
    const key = JSON.stringify(array.path);
    if (paths.has(key) || !Number.isSafeInteger(array.length) || array.length < 0 || array.length > 0xffffffff
      || !Array.isArray(array.parts)) throw new Error('The shared snapshot arrays are incomplete.');
    paths.add(key);
    let length = 0;
    for (const position of array.parts) {
      if (position !== next++) throw new Error('The shared snapshot data parts do not match their index.');
      const part = index.parts[position];
      if (!part || !['json', 'gzip'].includes(part.encoding)
        || !Number.isSafeInteger(part.rawBytes) || part.rawBytes < 2 || part.rawBytes > SNAPSHOT_PART_BYTES
        || !Number.isSafeInteger(part.records) || part.records < 1) {
        throw new Error('The shared snapshot has an invalid data part.');
      }
      length += part.records;
    }
    if (length !== array.length) throw new Error('The shared snapshot arrays are incomplete.');
  }
  if (next !== index.parts.length) throw new Error('The shared snapshot parts are incomplete.');
}

async function recordIndexDigest(index) {
  // Bind metadata, array lengths, order and every part hash without ever
  // concatenating the full snapshot. Retained files are not current data.
  const { sha256, retainedParts, ...document } = index;
  return digest(new TextEncoder().encode(JSON.stringify(document)));
}

async function compress(bytes) {
  if (typeof CompressionStream !== 'function') return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  return compressed.length < bytes.length ? compressed : bytes;
}

// Serialize bounded arrays of complete records. Neither publishing nor loading
// this format needs a single JSON string or byte buffer for the whole snapshot.
// The optional sink lets the disk writer release each part as soon as it exists.
export async function packRecordSnapshot(snapshot, partBytes = SNAPSHOT_PART_BYTES, writePart) {
  validateSnapshot(snapshot);
  if (!Number.isSafeInteger(partBytes) || partBytes < 2 || partBytes > SNAPSHOT_PART_BYTES) {
    throw new Error('Invalid snapshot part size.');
  }
  const arrays = [], sources = [];
  function skeleton(value, keys = []) {
    if (Array.isArray(value)) {
      arrays.push({ path: keys, length: value.length, parts: [] });
      sources.push(value);
      return [];
    }
    if (value && typeof value === 'object') {
      if (typeof value.toJSON === 'function') return value.toJSON();
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, skeleton(entry, [...keys, key])]));
    }
    return value;
  }
  const template = skeleton(snapshot);
  const parts = [], contents = [], encoder = new TextEncoder();
  let byteLength = 0;
  async function save(array, rows) {
    const raw = encoder.encode('[' + rows.join(',') + ']');
    const content = await compress(raw);
    const sha256 = await digest(content);
    const part = { file: `snapshot-parts/${sha256}.part`, bytes: content.length, sha256,
      rawBytes: raw.length, encoding: content === raw ? 'json' : 'gzip', records: rows.length };
    array.parts.push(parts.length);
    parts.push(part);
    byteLength += part.bytes;
    if (writePart) await writePart({ ...part, content });
    else contents.push({ ...part, content });
  }
  for (let i = 0; i < arrays.length; i++) {
    let rows = [], bytes = 2;
    for (const row of sources[i]) {
      // Match JSON.stringify(array) for undefined values, nulls and numbers.
      const json = JSON.stringify(row) ?? 'null';
      const size = encoder.encode(json).length;
      if (size + 2 > partBytes) throw new Error('A snapshot record exceeds the safe publishing size.');
      if (rows.length && bytes + 1 + size > partBytes) {
        await save(arrays[i], rows);
        rows = []; bytes = 2;
      }
      bytes += (rows.length ? 1 : 0) + size;
      rows.push(json);
    }
    if (rows.length) await save(arrays[i], rows);
  }
  const index = { storageFormat: RECORD_FORMAT, version: 1, generatedAt: snapshot.generatedAt,
    sourceTimestamp: snapshot.sourceTimestamp, sourceReport: snapshot.sourceReport,
    byteLength, snapshot: template, arrays, parts };
  index.sha256 = await recordIndexDigest(index);
  validateIndex(index);
  return { index, parts: contents };
}

export function snapshotPartFiles(index, includeRetained = false) {
  if (!isMultipartSnapshot(index)) {
    if (index?.storageFormat) throw new Error('The shared snapshot storage format is not supported.');
    return [];
  }
  validateIndex(index);
  return [...new Set([...index.parts.map(part => part.file), ...(includeRetained ? index.retainedParts || [] : [])])];
}

// Split the UTF-8 bytes, rather than rows or fields, so every value and record
// remains exactly the same. Parts are reassembled before JSON is decoded.
export async function packSnapshot(snapshot, partBytes = SNAPSHOT_PART_BYTES) {
  validateSnapshot(snapshot);
  if (!Number.isSafeInteger(partBytes) || partBytes < 1 || partBytes > SNAPSHOT_PART_BYTES) {
    throw new Error('Invalid snapshot part size.');
  }
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += partBytes) {
    const content = bytes.subarray(offset, offset + partBytes);
    const sha256 = await digest(content);
    parts.push({ file: `snapshot-parts/${sha256}.part`, bytes: content.length, sha256, content });
  }
  const index = {
    storageFormat: FORMAT,
    version: 1,
    generatedAt: snapshot.generatedAt,
    sourceTimestamp: snapshot.sourceTimestamp,
    sourceReport: snapshot.sourceReport,
    byteLength: bytes.length,
    sha256: await digest(bytes),
    parts: parts.map(({ content, ...part }) => part),
  };
  validateIndex(index);
  return { index, parts };
}

export async function unpackSnapshot(index, readPart) {
  if (!isMultipartSnapshot(index)) {
    if (index?.storageFormat) throw new Error('The shared snapshot storage format is not supported.');
    return validateSnapshot(index);
  }
  validateIndex(index);
  if (index.storageFormat === RECORD_FORMAT) return unpackRecordSnapshot(index, readPart);
  const bytes = new Uint8Array(index.byteLength);
  let offset = 0;
  const offsets = index.parts.map(part => { const start = offset; offset += part.bytes; return start; });
  let next = 0, failed = false;
  async function worker() {
    while (!failed && next < index.parts.length) {
      const position = next++;
      const part = index.parts[position];
      try {
        const raw = await readPart(part.file);
        const content = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        if (content.length !== part.bytes || await digest(content) !== part.sha256) {
          throw new Error('A shared snapshot data part is incomplete or corrupted.');
        }
        bytes.set(content, offsets[position]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  const workers = await Promise.allSettled(Array.from({ length: Math.min(4, index.parts.length) }, worker));
  const failure = workers.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  if (await digest(bytes) !== index.sha256) throw new Error('The shared snapshot data parts do not match their index.');
  const snapshot = validateSnapshot(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (['generatedAt', 'sourceTimestamp', 'sourceReport'].some(key => snapshot[key] !== index[key])) {
    throw new Error('The shared snapshot data belongs to a different update.');
  }
  return snapshot;
}

async function unpackRecordSnapshot(index, readPart) {
  if (await recordIndexDigest(index) !== index.sha256) {
    throw new Error('The shared snapshot data parts do not match their index.');
  }
  const snapshot = JSON.parse(JSON.stringify(index.snapshot));
  const jobs = [];
  for (const array of index.arrays) {
    const { parent, key } = arrayTarget(snapshot, array.path);
    const target = new Array(array.length);
    Object.defineProperty(parent, key, { value: target, enumerable: true, writable: true, configurable: true });
    let offset = 0;
    for (const position of array.parts) {
      jobs.push({ part: index.parts[position], target, offset });
      offset += index.parts[position].records;
    }
  }
  let next = 0, failed = false;
  async function worker() {
    while (!failed && next < jobs.length) {
      const { part, target, offset } = jobs[next++];
      try {
        const raw = await readPart(part.file);
        let content = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        if (content.length !== part.bytes || await digest(content) !== part.sha256) {
          throw new Error('A shared snapshot data part is incomplete or corrupted.');
        }
        if (part.encoding === 'gzip') {
          const stream = new Blob([content]).stream().pipeThrough(new DecompressionStream('gzip'));
          const reader = stream.getReader();
          content = new Uint8Array(part.rawBytes);
          let offset = 0;
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              if (offset + value.length > content.length) throw new Error('A shared snapshot data part is incomplete or corrupted.');
              content.set(value, offset); offset += value.length;
            }
            if (offset !== content.length) throw new Error('A shared snapshot data part is incomplete or corrupted.');
          } finally { await reader.cancel(); }
        }
        if (content.length !== part.rawBytes) throw new Error('A shared snapshot data part is incomplete or corrupted.');
        const rows = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
        if (!Array.isArray(rows) || rows.length !== part.records) throw new Error('The shared snapshot arrays are incomplete.');
        for (let i = 0; i < rows.length; i++) target[offset + i] = rows[i];
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  const workers = await Promise.allSettled(Array.from({ length: Math.min(4, jobs.length) }, worker));
  const failure = workers.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  validateSnapshot(snapshot);
  if (['generatedAt', 'sourceTimestamp', 'sourceReport'].some(key => snapshot[key] !== index[key])) {
    throw new Error('The shared snapshot data belongs to a different update.');
  }
  return snapshot;
}

export async function fetchSharedSnapshot(fetcher = globalThis.fetch) {
  const refresh = Date.now();
  const options = () => ({ cache: 'no-store', signal: AbortSignal.timeout(45000) });
  const response = await fetcher(`./snapshot.json?refresh=${refresh}`, options());
  if (!response.ok) throw new Error('Shared snapshot request failed (' + response.status + ').');
  return unpackSnapshot(await response.json(), async file => {
    const part = await fetcher(`./${file}?refresh=${refresh}`, options());
    if (!part.ok) throw new Error('Shared snapshot data part request failed (' + part.status + ').');
    return part.arrayBuffer();
  });
}
