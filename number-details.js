import { totals } from './data.js';
import { groupDetail } from './export.js';

// A click keeps the displayed source context and the applied selections.
// Source values and source grains are retained; no Power BI measure is rebuilt.
export function captureContext(view, mode, applied, organization, snapshot) {
  return {view,mode,applied:structuredClone(applied),organization,
    sourceTimestamp:snapshot.sourceTimestamp,snapshotGeneratedAt:snapshot.generatedAt};
}

export function metricScenario(context, options={}) {
  const dataset=options.dataset || 'detail';
  let rows=options.rows ?? context.view[dataset] ?? [];
  const metric=options.metric || 'records';
  if(metric==='maxDeviation' && Number.isFinite(options.value)) {
    rows=rows.filter(r=>Number.isFinite(r.DeviationPct) && Math.abs(Math.abs(r.DeviationPct)-options.value)<1e-8);
  }
  return {context,dataset,metric,rows,value:options.value,label:options.label || metric,
    entity:options.entity || '',presentation:options.presentation ||
      (metric==='outlets'?'outlets':metric==='articles'?'articles':'details'),
    sourceMeasure:Boolean(options.sourceMeasure),note:options.note || '',trend:options.trend || null,
    title:options.title || [options.label || metric,options.entity].filter(Boolean).join(' · ')};
}

export function groupScenario(context, key, value, options={}) {
  const dataset=options.dataset || 'detail';
  const rows=(context.view[dataset] || []).filter(r=>String(r[key] || 'Not mapped')===String(value));
  return metricScenario(context,{...options,dataset,rows,entity:String(value)});
}

export function rowScenario(context, row, column, dataset='detail') {
  const grouped=Array.isArray(row.rows);
  const entity=grouped ? row.Name || row.OutletCode || row.ArticleCode :
    [row.OutletCode,row.ArticleCode,row.Date || row.Day].filter(Boolean).join(' · ');
  return metricScenario(context,{rows:grouped?row.rows:[row],dataset,metric:column.key,
    value:row[column.key],label:column.label,entity,
    note:column.key==='maxDeviation'?'Records attaining the highest absolute deviation in this group.':''});
}

export function ownershipScenario(context, part='coverage') {
  const all=context.view.detail,codes=new Set(all.map(r=>r.OutletCode));
  const mapped=new Set(all.filter(r=>r.Mapping==='Mapped').map(r=>r.OutletCode));
  const rows=part==='mapped'?all.filter(r=>r.Mapping==='Mapped'):
    part==='unmapped'?all.filter(r=>r.Mapping!=='Mapped'):all;
  const value=part==='coverage'?(codes.size?mapped.size/codes.size*100:0):
    part==='mapped'?mapped.size:part==='unmapped'?codes.size-mapped.size:codes.size;
  return metricScenario(context,{rows,metric:part==='coverage'?'coverage':'outlets',value,
    label:part==='coverage'?'Outlet ownership connected':part==='mapped'?'Mapped outlets':
      part==='unmapped'?'Unmapped outlets':'Outlets to review',presentation:'outlets',
    note:`${mapped.size} of ${codes.size} review outlets have mapped ownership. Unmapped and conflicting records remain in the source totals.`});
}

export function trendScenario(context, row, key) {
  const dataset=context.mode==='buy'?'detail':'supplemental';
  const rows=(context.view[dataset] || []).filter(r=>row.Date?r.Date===row.Date:
    Boolean(row.Day)&&r.Day===row.Day);
  return metricScenario(context,{rows,dataset,metric:key,value:row[key],trend:row,sourceMeasure:true,
    label:key==='Quantity'?'Daily source quantity':key==='Benchmark'?'Daily source benchmark':
      context.mode==='buy'?'Daily unit receiving cost':'Daily incident sale price',
    entity:row.Date || row.Day,
    note:context.mode==='buy'?'The selected point is a Power BI daily chart measure. The related review records retain their original day–outlet–article prices.':
      'The selected point is a Power BI daily chart measure. Related daily exceptions retain the original below −20% rule, separately from periodic incidents.'});
}

export function mappingScenario(context, code=null) {
  const rows=context.organization.rows.filter(r=>code==null || r.OutletCode===code);
  return metricScenario(context,{rows,dataset:'organization',metric:'mappings',value:rows.length,
    label:code==null?'Outlet hierarchy mappings':'Outlet hierarchy mapping',entity:code || '',
    presentation:'organization',note:'Published Zone Distribution ownership records.'});
}

export function scenarioRows(scenario) {
  if(scenario.presentation==='organization')return scenario.rows;
  if(scenario.presentation==='outlets')return groupDetail(scenario.rows,'OutletCode')
    .map(r=>({...r,Mapping:r.rows[0]?.Mapping}));
  if(scenario.presentation==='articles')return groupDetail(scenario.rows,'ArticleCode');
  return scenario.rows;
}

export function scenarioTotals(scenario) {
  if(scenario.presentation==='trend')return {records:scenario.rows.length,outlets:0,articles:0,benchmarkGap:null};
  return scenario.presentation==='organization'?{records:scenario.rows.length,
    outlets:new Set(scenario.rows.map(r=>r.OutletCode)).size,articles:0,benchmarkGap:null}:
    totals(scenario.rows);
}

export function sourceMeasures(scenario) {
  if(scenario.trend)return [['Quantity','Daily source quantity'],['UnitPrice','Daily source unit price'],['Benchmark','Daily source benchmark']]
    .map(([key,label])=>({key,label,type:'quantity',value:scenario.trend[key]})).filter(r=>Number.isFinite(r.value));
  if(scenario.sourceMeasure && scenario.entity && ['incidents','Incidents'].includes(scenario.metric))
    return [{key:'Incidents',label:scenario.label,value:scenario.value}];
  const summary=scenario.context.view.summary;
  const measures=[['Incidents','Source incidents'],['IncidentRate','Source incident rate','ratio'],
    ['UnitPrice','Source unit price','quantity'],['Benchmark','Source benchmark','quantity'],
    ['SaleMargin','Source sale margin','ratio'],['SourceAvgSaleMargin','Average sale margin','ratio'],
    ['SalesQuantity','Source sales quantity','quantity'],['NetSales','Source net sales · BDT','money'],
    ['COGS','Source COGS · BDT','money'],['ReceivingQuantity','Source receiving quantity','quantity'],
    ['ReceivingCost','Source receiving cost · BDT','money']];
  return measures.filter(([key])=>Number.isFinite(key==='SaleMargin'?
    summary.SaleMargin ?? summary.SourceSaleMargin:summary[key])).map(([key,label,type])=>({
      key,label,type,value:key==='SaleMargin'?summary.SaleMargin ?? summary.SourceSaleMargin:summary[key]}));
}
