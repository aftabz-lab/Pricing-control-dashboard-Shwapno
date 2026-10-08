import { column, measure, sum, compare, PricingClient } from './powerbi.js';
import { enrich } from './organization.js';

export const VISUALS = Object.freeze({
  buy: {detail:'545b80615c65de66b044',dc:'4f61e68528857c0e3081',trend:'18bc2e25ba2ecc4d1cb1',summary:'aabada71a5775a2a89ca',category:'6beb31cfc30750224b44',subCategory:'a46b98bb20c05a30a893'},
  sale: {detail:'92f0a026c37fbd6736bd',daily:'092bb7640a207ab47145',trend:'9726fd1bb4c0c18916e1',summary:'b4b20397e4e8580042b8',subCategory:'b0e052835c760c1a934b'},
});
export function summarySpec(client,mode,filters={}) {
  const select = mode === 'buy' ? [
    measure('Over Buying Price','Over Pricing Total Incident','Incidents'),measure('Over Buying Price','Over Pricing Incident%','IncidentRate'),
    measure('Over Cost Price','Unit Receiving Cost','UnitPrice'),measure('Over Buying Price','Avg Unit Receiving Cost','Benchmark'),
    measure('Over Buying Price','Over Buying → Sale Margin %','SaleMargin'),
  ] : [
    measure('Over/Under Pricing','Under Pricing Total Incident','Incidents'),
    measure('Over/Under Pricing','Incident Avg Price','UnitPrice'),measure('Over/Under Pricing','National Avg Price','Benchmark'),
  ];
  select.push(sum('Query1','ActualInvoicedQuantity','SalesQuantity'),sum('Query1','NSI','NetSales'),sum('Query1','COG(SAP)','COGS'));
  if (mode === 'buy') select.push(sum('Query3','qty_in_unit_of_entry','ReceivingQuantity'),sum('Query3','amt_in_loc_cur','ReceivingCost'));
  return {key:'summary',select,where:client.scopeWhere(mode,filters),count:1};
}
export function modeSpecs(client,mode,filters={}) {
  const visuals=VISUALS[mode], n=Number(filters.deviationFloor ?? client.scopes[mode].deviationFloor);
  // Measures retain their source formulas. These comparisons select the
  // exception rows identified by the source threshold at the same grain.
  const detail=client.visualSpec(mode,visuals.detail,'detail',filters);
  const partition={activity:sum(mode==='buy'?'Query3':'Query1',mode==='buy'?'qty_in_unit_of_entry':'ActualInvoicedQuantity')};
  detail.partition=partition;
  if(mode==='sale'){
    // Restrict the transport to below-floor rows without adding any grouping
    // field that would change the national benchmark. The model's strict
    // quantity floor is applied below, at the original Outlet–Article grain.
    detail.where.push(compare(measure('Over/Under Pricing','Price Deviation %'),3,`${-n}D`));
    detail.count=1000;
  }
  const trend=client.visualSpec(mode,visuals.trend,'trend',filters);
  const entity=mode === 'buy'?'Over Buying Price':'Over/Under Pricing';
  const incidentName=mode === 'buy'?'Over Pricing Total Incident':'Under Pricing Total Incident';
  const category={key:'categories',select:[column('DimArticle','Category3','Category'),measure(entity,incidentName,'Incidents')],where:client.scopeWhere(mode,filters),count:30000};
  const specs=[summarySpec(client,mode,filters),client.visualSpec(mode,visuals.summary,'summaryText',filters),category,client.visualSpec(mode,visuals.subCategory,'subcategories',filters),trend,detail];
  if (mode === 'buy') specs.push({...client.visualSpec(mode,visuals.dc,'dc',filters),partition});
  else specs.push({...client.visualSpec(mode,visuals.daily,'daily',filters),partition});
  return specs;
}
export function normalizeDetail(raw, mode) {
  const dateValue=raw.Date;
  const date = typeof dateValue === 'number' ? new Date(dateValue).toISOString().slice(0,10) : typeof dateValue === 'string' ? dateValue.slice(0,10) : null;
  const dc=Object.hasOwn(raw,'Deviation DC %');
  const quantity=raw[mode === 'buy'?'Receiving Qty':'Quantity'];
  const unit=raw[mode === 'buy'?'Unit Receiving Cost':'Incident Avg Price'];
  const benchmark=raw[mode === 'buy'?(dc?'Avg Unit Receiving Cost DC':'Avg Unit Receiving Cost'):'National Avg Price'];
  const deviation=raw[mode === 'buy'?(dc?'Deviation DC %':'Deviation % (Above n)'):'Price Deviation %'];
  const unitDifference=mode === 'buy' ? raw[dc?'Over Pricing Deviation DC':'Over Pricing Deviation'] : unit != null && benchmark != null ? benchmark-unit : null;
  return {OutletCode:raw.OutletCode,OutletName:raw.OutletName || '',ArticleCode:raw.ArticleNo,ArticleName:raw.ArticleName,Category:raw.Category || raw.Cat || raw['Cat 3'] || raw.Subcategory,
    Subcategory:raw.Subcategory || raw['Cat 3'],MasterCategory:raw.MasterCategory,Region:raw.Region,
    Date:date,Day:raw.Day || raw['Day Label'] || '',Quantity:quantity,Amount:raw[mode === 'buy'?'Receiving Cost':'NSI'],COGS:raw['COG (SAP)'] ?? null,
    UnitPrice:unit,Benchmark:benchmark,DeviationPct:deviation,UnitDifference:unitDifference,
    BenchmarkGap:quantity != null && unitDifference != null ? Math.max(0,quantity*unitDifference) : null,
    SaleMargin:raw['Incident Sale Margin %'] ?? null,AvgMargin:raw['Avg Sale Margin %'] ?? null,Type:dc?'DC comparison':mode === 'buy'?'Over buying':'Under sale'};
}
export function normalizeMode(result,mode,scope,organization, dimensions={}) {
  const sourceText=String(Object.values(result.summaryText?.[0] || {})[0] || '').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
  const margin=sourceText.match(/the Sale Margin% was\s*(-?[\d.]+)%/i),avg=sourceText.match(/Average Sale Margin%\s*(-?[\d.]+)%/i);
  const summary={...result.summary?.[0],SourceText:sourceText,SourceSaleMargin:margin?Number(margin[1])/100:null,SourceAvgSaleMargin:avg?Number(avg[1])/100:null};
  const articles=new Map((dimensions.articles || []).map(r=>[String(r.ArticleCode),r]));
  const sourceOutlets=new Map((dimensions.outlets || []).map(r=>[String(r.OutletCode),r]));
  const dates=new Map((dimensions.calendar || []).map(r=>[r.Day,r.Date]));
  function normalize(raw) {
    const r=normalizeDetail(raw,mode), a=articles.get(String(r.ArticleCode));
    return {...r,Region:sourceOutlets.get(String(r.OutletCode))?.Region || r.Region,MasterCategory:a?.MasterCategory || r.MasterCategory || '',Category:a?.Category || r.Category,Subcategory:a?.Subcategory || r.Subcategory,Date:dates.get(r.Day) || null};
  }
  const n=Number(scope.deviationFloor),q=Number(scope.qtyFloor);
  const detail=enrich((result.detail || []).map(normalize).filter(r=>Number.isFinite(r.DeviationPct) && Number.isFinite(r.Quantity) && r.Quantity>q && (mode === 'buy' ? r.DeviationPct>n : r.DeviationPct< -n)),organization);
  const supplemental=enrich((result[mode === 'buy'?'dc':'daily'] || []).map(normalize),organization);
  const byOutlet=new Map();
  for (const r of detail) {
    if (!byOutlet.has(r.OutletCode)) byOutlet.set(r.OutletCode,{OutletCode:r.OutletCode,OutletName:r.OutletName,Incidents:0});
    byOutlet.get(r.OutletCode).Incidents++;
  }
  const outlets=enrich([...byOutlet.values()],organization);
  const trend=(result.trend || []).map(raw => {
    const r=normalizeDetail(raw,mode);
    return {Date:dates.get(raw['Day Label']) || r.Date,Day:raw['Day Label'],Quantity:raw[mode === 'buy'?'Receiving Qty':'Sum of ActualInvoicedQuantity'],UnitPrice:raw[mode === 'buy'?'Unit Receiving Cost ':'Incident average price (Chart)'],Benchmark:raw[mode === 'buy'?'Avg Unit Receiving Cost':'National Avg Price']};
  }).sort((a,b)=>String(a.Date).localeCompare(String(b.Date)));
  const categories=(result.categories || []).filter(r=>Number(r.Incidents)>0);
  const subcategories=(result.subcategories || []).map(r=>({Category:r['Cat 3'],Incidents:r[mode === 'buy'?'Over Pricing Total Incident':'Under Pricing Total Incident'],IncidentRate:r['Over Pricing Incident%'] ?? null})).filter(r=>Number(r.Incidents)>0);
  return {scope:{start:scope.start,end:scope.end,deviationFloor:scope.deviationFloor,qtyFloor:scope.qtyFloor,masterCategories:scope.masterCategories},summary,outlets,categories,subcategories,trend,detail,supplemental};
}
export async function loadMode(client,mode,filters,organization,dimensions) {
  const calendar=await client.run([{key:'calendar',select:[column('DimDate','Date','Date'),column('DimDate','Day Label','Day')],where:client.scopeWhere(mode,filters).filter(w=>JSON.stringify(w).includes('datetime')),count:5000}]);
  const dayMap=new Map();
  for(const r of calendar.calendar){const d=typeof r.Date==='number'?new Date(r.Date).toISOString().slice(0,10):String(r.Date).slice(0,10);if(dayMap.has(r.Day))dayMap.set(r.Day,null);else dayMap.set(r.Day,d);}
  dimensions={...dimensions,calendar:[...dayMap].map(([Day,Date])=>({Day,Date}))};
  const result=await client.run(modeSpecs(client,mode,filters));
  return normalizeMode(result,mode,{...client.scopes[mode],...filters},organization,dimensions);
}
export function totals(rows) {
  return {records:rows.length,outlets:new Set(rows.map(r=>r.OutletCode)).size,articles:new Set(rows.map(r=>r.ArticleCode)).size,
    benchmarkGap:rows.reduce((a,r)=>a+(r.BenchmarkGap || 0),0),quantity:rows.reduce((a,r)=>a+(r.Quantity || 0),0),amount:rows.reduce((a,r)=>a+(r.Amount || 0),0),
    maxDeviation:rows.length ? Math.max(...rows.filter(r=>Number.isFinite(r.DeviationPct)).map(r=>Math.abs(r.DeviationPct))) : null};
}
export function groupRows(rows,key) {
  const groups=new Map();
  for (const r of rows) {
    const name=r[key] || 'Not mapped';
    if (!groups.has(name)) groups.set(name,[]);
    groups.get(name).push(r);
  }
  return [...groups].map(([Name,list])=>({Name,...totals(list)})).sort((a,b)=>b.benchmarkGap-a.benchmarkGap || b.records-a.records);
}
