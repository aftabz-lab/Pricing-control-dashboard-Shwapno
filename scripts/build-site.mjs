import fs from 'node:fs/promises';
import path from 'node:path';
import { SNAPSHOT_PART_BYTES, snapshotPartFiles } from '../snapshot-storage.js';
import { readStoredSnapshot } from './snapshot-files.mjs';
const root=path.resolve(new URL('..',import.meta.url).pathname);
export async function buildSite(root){
  await readStoredSnapshot(root);
  const index=JSON.parse(await fs.readFile(path.join(root,'snapshot.json'),'utf8'));
  const out=path.join(root,'_site');await fs.rm(out,{recursive:true,force:true});await fs.mkdir(out);
  for(const name of ['index.html','styles.css','app.js','settings.js','powerbi.js','organization.js','data.js','snapshot-state.js','snapshot-storage.js','export.js','xlsx-lite.js','number-details.js','snapshot.json','snapshot-status.json','.nojekyll'])await fs.copyFile(path.join(root,name),path.join(out,name));
  for(const file of snapshotPartFiles(index,true)){
    if((await fs.stat(path.join(root,file))).size>SNAPSHOT_PART_BYTES)throw new Error('A snapshot data part exceeds the safe publishing size.');
    await fs.mkdir(path.dirname(path.join(out,file)),{recursive:true});
    await fs.copyFile(path.join(root,file),path.join(out,file));
  }
  console.log('Static dashboard prepared with its validated snapshot.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname))await buildSite(root);
