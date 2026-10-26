import fs from 'node:fs/promises';
import path from 'node:path';
import { SNAPSHOT_PART_BYTES, packRecordSnapshot, unpackSnapshot, snapshotPartFiles } from '../snapshot-storage.js';

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

export async function readStoredSnapshotMetadata(root) {
  // Validate the previous snapshot exactly as before, then release its rows.
  // Update decisions and failure status only use these metadata fields.
  const snapshot = await readStoredSnapshot(root);
  return { version: snapshot.version, generatedAt: snapshot.generatedAt,
    sourceTimestamp: snapshot.sourceTimestamp, sourceReport: snapshot.sourceReport,
    metadataFingerprint: snapshot.metadataFingerprint, dataFingerprint: snapshot.dataFingerprint,
    organization: { updatedAt: snapshot.organization.updatedAt },
    modes: Object.fromEntries(['buy', 'sale'].map(mode => [mode, { scope: snapshot.modes[mode].scope }])) };
}

export async function writeStoredSnapshot(root, snapshot, partBytes) {
  let previous = null;
  try {
    previous = JSON.parse(await fs.readFile(path.join(root, 'snapshot.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(path.join(root, 'snapshot-parts'), { recursive: true });
  const { index } = await packRecordSnapshot(snapshot, partBytes,
    part => atomic(path.join(root, part.file), part.content));
  // Retain one previous set so a reader holding the prior index can finish
  // during a Pages deployment. Only the current set is loaded by new readers.
  const currentFiles = new Set(snapshotPartFiles(index));
  index.retainedParts = snapshotPartFiles(previous).filter(file => !currentFiles.has(file));
  const indexJson = JSON.stringify(index) + '\n';
  if (Buffer.byteLength(indexJson) > SNAPSHOT_PART_BYTES) throw new Error('The snapshot index exceeds the safe publishing size.');
  // Publish the index only after every immutable, hash-named part exists.
  await atomic(path.join(root, 'snapshot.json'), indexJson);
  const keep = new Set(snapshotPartFiles(index, true));
  for (const name of await fs.readdir(path.join(root, 'snapshot-parts'))) {
    const file = `snapshot-parts/${name}`;
    if (/^[a-f0-9]{64}\.part$/.test(name) && !keep.has(file)) await fs.rm(path.join(root, file));
  }
  return index;
}
