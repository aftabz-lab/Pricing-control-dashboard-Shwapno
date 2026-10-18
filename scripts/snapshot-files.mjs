import fs from 'node:fs/promises';
import path from 'node:path';
import { SNAPSHOT_PART_BYTES, packSnapshot, unpackSnapshot, snapshotPartFiles } from '../snapshot-storage.js';

async function atomic(file, content) {
  const temporary = file + '.tmp';
  try {
    await fs.writeFile(temporary, content);
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function readStoredSnapshot(root) {
  const index = JSON.parse(await fs.readFile(path.join(root, 'snapshot.json'), 'utf8'));
  return unpackSnapshot(index, file => fs.readFile(path.join(root, file)));
}

export async function writeStoredSnapshot(root, snapshot, partBytes) {
  const { index, parts } = await packSnapshot(snapshot, partBytes);
  let previous = null;
  try {
    previous = JSON.parse(await fs.readFile(path.join(root, 'snapshot.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Retain one previous set so a reader holding the prior index can finish
  // during a Pages deployment. Only the current set is loaded by new readers.
  const currentFiles = new Set(snapshotPartFiles(index));
  index.retainedParts = snapshotPartFiles(previous).filter(file => !currentFiles.has(file));
  const indexJson = JSON.stringify(index) + '\n';
  if (Buffer.byteLength(indexJson) > SNAPSHOT_PART_BYTES) throw new Error('The snapshot index exceeds the safe publishing size.');
  await fs.mkdir(path.join(root, 'snapshot-parts'), { recursive: true });
  for (const part of parts) await atomic(path.join(root, part.file), part.content);
  // Publish the index only after every immutable, hash-named part exists.
  await atomic(path.join(root, 'snapshot.json'), indexJson);
  const keep = new Set(snapshotPartFiles(index, true));
  for (const name of await fs.readdir(path.join(root, 'snapshot-parts'))) {
    const file = `snapshot-parts/${name}`;
    if (/^[a-f0-9]{64}\.part$/.test(name) && !keep.has(file)) await fs.rm(path.join(root, file));
  }
  return index;
}
