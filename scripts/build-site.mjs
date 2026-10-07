import fs from 'node:fs/promises';
import path from 'node:path';
import { validateSnapshot } from '../snapshot-state.js';
const root=path.resolve(new URL('..',import.meta.url).pathname);
validateSnapshot(JSON.parse(await fs.readFile(path.join(root,'snapshot.json'),'utf8')));
const out=path.join(root,'_site');await fs.rm(out,{recursive:true,force:true});await fs.mkdir(out);
for(const name of ['index.html','styles.css','app.js','settings.js','powerbi.js','organization.js','data.js','snapshot-state.js','export.js','xlsx-lite.js','number-details.js','snapshot.json','snapshot-status.json','.nojekyll'])await fs.copyFile(path.join(root,name),path.join(out,name));
console.log('Static dashboard prepared with its validated snapshot.');
