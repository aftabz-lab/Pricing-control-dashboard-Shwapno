import { validateSnapshot } from './snapshot-state.js';

export const SNAPSHOT_PART_BYTES = 8 * 1024 * 1024;
const FORMAT = 'shwapno-pricing-snapshot-parts-v1';
const PART_FILE = /^snapshot-parts\/[a-f0-9]{64}\.part$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function isMultipartSnapshot(value) {
  return value?.storageFormat === FORMAT;
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
  return value;
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
