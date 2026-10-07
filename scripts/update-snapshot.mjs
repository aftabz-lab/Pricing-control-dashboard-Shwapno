import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PricingClient, column, sum, compare } from '../powerbi.js';
import { loadMode } from '../data.js';
import { loadOrganization } from '../organization.js';
import { validateSnapshot, canReplaceSnapshot } from '../snapshot-state.js';
import { SETTINGS } from '../settings.js';

const root=path.resolve(new URL('..',import.meta.url).pathname);
const statusPath=path.join(root,'snapshot-status.json');
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
async function atomic(file,value){const temp=file+'.tmp';await fs.writeFile(temp,JSON.stringify(value,null,2)+'\n');await fs.rename(temp,file);}
async function existing(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch{return null;}}
function iso(value){return typeof value==='number'?new Date(value).toISOString().slice(0,10):String(value).slice(0,10);}
export async function fingerprint(client){
  const r=await client.run([{key:'marker',select:[sum('Query1','ActualInvoicedQuantity','SalesQty'),sum('Query1','NSI','NetSales'),sum('Query1','COG(SAP)','COGS'),sum('Query3','qty_in_unit_of_entry','ReceivingQty'),sum('Query3','amt_in_loc_cur','ReceivingAmount')],count:1}]);
  return hash(r.marker);
}
export async function latestSourceDate(client){
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Dhaka'});
  for(const mode of ['buy','sale']){
    const scope=client.scopes[mode];
    if(scope.end>=today)continue;
    const where=client.scopeWhere(mode,{start:scope.end,end:today});
    const result=await client.run([{key:'dates',select:[column('DimDate','Date','Date'),sum(mode==='buy'?'Query3':'Query1',mode==='buy'?'qty_in_unit_of_entry':'ActualInvoicedQuantity','Quantity')],where,count:5000}]);
    const active=result.dates.filter(r=>Number(r.Quantity)!==0&&Number.isFinite(Number(r.Quantity))).map(r=>iso(r.Date)).sort();
    if(active.length&&active.at(-1)>scope.end)scope.end=active.at(-1);
  }
}
export async function dimensionsFor(client){
  const s=client.scopes.sale,b=client.scopes.buy;
  const start=s.start<b.start?s.start:b.start,end=s.end>b.end?s.end:b.end;
  const where=client.scopeWhere('sale',{start,end,masterCategories:[]}).filter(w=>!JSON.stringify(w).includes('Floor'));
  where.push({Condition:{Or:{Left:compare(sum('Query1','ActualInvoicedQuantity'),1,'0L').Condition,Right:compare(sum('Query3','qty_in_unit_of_entry'),1,'0L').Condition}}});
  const r=await client.run([
    {key:'articles',select:[column('DimArticle','ArticleNo','ArticleCode'),column('DimArticle','ArticleName','ArticleName'),column('DimArticle','MasterCategory','MasterCategory'),column('DimArticle','Category3','Category'),column('DimArticle','Cat 3','Subcategory'),sum('Query1','ActualInvoicedQuantity','SalesQty'),sum('Query3','qty_in_unit_of_entry','ReceivingQty')],where,count:5000},
    {key:'outlets',select:[column('DimOutlet','OutletCode','OutletCode'),column('DimOutlet','OutletName','OutletName'),column('DimOutlet','RegionName','Region')],count:5000},
    {key:'movements',select:[column('Query3','movement_type','value')],count:5000},
    {key:'purchaseTypes',select:[column('Query3','Purchase Type','value')],count:5000},
  ]);
  const byArticle=new Map();
  for(const raw of r.articles){const {SalesQty,ReceivingQty,...article}=raw;if(article.ArticleCode&&!byArticle.has(article.ArticleCode))byArticle.set(article.ArticleCode,article);}
  const byOutlet=new Map();
  for(const row of r.outlets){const key=row.OutletCode || 'Not supplied';if(!byOutlet.has(key))byOutlet.set(key,{...row,SourceOutletCode:row.OutletCode || null,OutletCode:key,OutletName:row.OutletName || key});}
  return {articles:[...byArticle.values()],outlets:[...byOutlet.values()],movements:r.movements.map(r=>r.value).filter(v=>v!=null),purchaseTypes:r.purchaseTypes.map(r=>r.value).filter(v=>v!=null),window:{start,end}};
}
async function main(){
  const previous=await existing(path.join(root,'snapshot.json'));
  const now=new Date().toISOString();
  console.log('Connecting to published Power BI pricing report.');
  const client=await new PricingClient().connect();
  const organization=await loadOrganization();
  await latestSourceDate(client);
  const metadataFingerprint=hash({source:client.settings.reportUrl,refresh:client.sourceTimestamp,report:client.explorationDocument});
  const dataFingerprint=await fingerprint(client);
  const maxAge=Number(process.env.MAX_SNAPSHOT_AGE_HOURS || SETTINGS.maxSnapshotAgeHours);
  const force=/^(1|true|yes)$/i.test(process.env.FORCE_SNAPSHOT || '');
  const same=previous?.metadataFingerprint===metadataFingerprint&&previous?.dataFingerprint===dataFingerprint&&previous?.organization?.updatedAt===organization.updatedAt&&['buy','sale'].every(k=>previous?.modes?.[k]?.scope.end===client.scopes[k].end);
  const due=!previous?.generatedAt||(maxAge>0&&Date.now()-Date.parse(previous.generatedAt)>=maxAge*3600000);
  if(same&&!force&&!due){await atomic(statusPath,{version:1,result:'unchanged',lastCheckedAt:now,sourceTimestamp:client.sourceTimestamp,snapshotGeneratedAt:previous.generatedAt,sourceReport:client.settings.reportUrl});console.log('No source change. Last validated snapshot retained.');return;}
  console.log('Loading active article dimensions and outlet identifiers.');
  const dimensions=await dimensionsFor(client);
  const modes={};
  for(const mode of ['buy','sale']){
    console.log(`Querying ${mode} source measures, complete exception rows and comparison table.`);
    modes[mode]=await loadMode(client,mode,{},organization,dimensions);
    if(process.env.SNAPSHOT_DIAGNOSTICS_DIR){await fs.mkdir(process.env.SNAPSHOT_DIAGNOSTICS_DIR,{recursive:true});await atomic(path.join(process.env.SNAPSHOT_DIAGNOSTICS_DIR,`snapshot-${mode}.json`),modes[mode]);}
    console.log(`${mode}: ${modes[mode].summary.Incidents} source incidents, ${modes[mode].detail.length} eligible detail rows, ${modes[mode].supplemental.length} separate comparison rows.`);
    if(modes[mode].summary.Incidents>0&&!modes[mode].detail.length)throw new Error(`${mode} detail rows are missing despite a positive source headline.`);
  }
  // Re-read both the model marker and actual source totals. A refresh during
  // extraction must never create a mixed or partially updated public snapshot.
  const verify=await new PricingClient(client.settings).connect();
  const endMetadata=hash({source:verify.settings.reportUrl,refresh:verify.sourceTimestamp,report:verify.explorationDocument});
  const endData=await fingerprint(verify);
  if(endMetadata!==metadataFingerprint||endData!==dataFingerprint)throw new Error('Power BI changed while the snapshot was being built. Retry with a consistent source refresh.');
  const snapshot={version:1,generatedAt:new Date().toISOString(),sourceTimestamp:client.sourceTimestamp,sourceReport:client.settings.reportUrl,metadataFingerprint,dataFingerprint,organization,dimensions,modes};
  validateSnapshot(snapshot);
  if(previous&&!canReplaceSnapshot(snapshot,previous))throw new Error('The proposed snapshot is older than the published data window. The newer snapshot is retained.');
  await atomic(path.join(root,'snapshot.json'),snapshot);
  await atomic(statusPath,{version:1,result:'updated',lastCheckedAt:snapshot.generatedAt,sourceTimestamp:snapshot.sourceTimestamp,snapshotGeneratedAt:snapshot.generatedAt,sourceReport:snapshot.sourceReport,sourceIncidents:{buy:modes.buy.summary.Incidents,sale:modes.sale.summary.Incidents},hierarchyUpdatedAt:organization.updatedAt});
  console.log('Complete validated snapshot published locally.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)){
  main().catch(async error=>{
    console.error('Snapshot update failed:',error.message);
    const old=await existing(path.join(root,'snapshot.json'));
    await atomic(statusPath,{version:1,result:'failed',lastCheckedAt:new Date().toISOString(),lastFailureAt:new Date().toISOString(),snapshotGeneratedAt:old?.generatedAt || null,sourceTimestamp:old?.sourceTimestamp || null,error:error.message,runUrl:process.env.GITHUB_SERVER_URL&&process.env.GITHUB_REPOSITORY&&process.env.GITHUB_RUN_ID?`${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`:null});
    process.exitCode=1;
  });
}
