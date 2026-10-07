import { downloadWorkbook } from './xlsx-lite.js';
import { totals } from './data.js';

export const DETAIL_COLUMNS = [
  ['OutletCode','Outlet code'],['OutletName','Outlet name'],['SourceOutletCode','Original source outlet code'],['Date','Date'],['Day','Day label'],['Division','Division'],['District','District'],['RHO','RHO'],['Zonal','Zonal'],
  ['ArticleCode','Article code'],['ArticleName','Article name'],['Category','Category'],['Subcategory','Subcategory'],['Quantity','Quantity'],['Amount','Source amount (BDT)'],['COGS','COGS (BDT)'],
  ['UnitPrice','Source unit price (BDT)'],['Benchmark','Source benchmark (BDT)'],['DeviationPct','Source deviation (%)'],['UnitDifference','Unit difference (BDT)'],['BenchmarkGap','Indicative benchmark gap (BDT)'],['SaleMargin','Source sale margin (ratio)'],['AvgMargin','Source average margin (ratio)'],['Mapping','Hierarchy mapping'],
];
export function groupDetail(rows,key) {
  const map=new Map();
  for (const row of rows) {
    const value=row[key] || 'Not mapped';
    if (!map.has(value)) map.set(value,[]);
    map.get(value).push(row);
  }
  return [...map].map(([Name,list])=>({Name,OutletCode:list[0].OutletCode,OutletName:list[0].OutletName,ArticleCode:list[0].ArticleCode,ArticleName:list[0].ArticleName,
    Category:list[0].Category,RHO:list[0].RHO,Zonal:list[0].Zonal,Division:list[0].Division,...totals(list),rows:list})).sort((a,b)=>b.benchmarkGap-a.benchmarkGap);
}
export function csvText(columns,rows) {
  const cell=value=>{
    let text=String(value ?? '');
    if (typeof value === 'string' && /^[=+@-]/.test(text)) text="'"+text;
    return '"'+text.replaceAll('"','""')+'"';
  };
  return '\uFEFF'+[columns.map(c=>cell(c[1])).join(','),...rows.map(row=>columns.map(c=>cell(row[c[0]])).join(','))].join('\r\n');
}
export function saveCsv(columns,rows,name) {
  const url=URL.createObjectURL(new Blob([csvText(columns,rows)],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=name+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);
}
function sheet(name,columns,rows) {return {name,rows:[columns.map(c=>c[1]),...rows.map(r=>columns.map(c=>r[c[0]] ?? ''))]};}
export const LEADER_COLUMNS=[['Name','Leader'],['records','Eligible detail rows'],['outlets','Outlets'],['articles','Articles'],['benchmarkGap','Indicative benchmark gap (BDT)'],['quantity','Quantity'],['amount','Source amount (BDT)'],['maxDeviation','Highest absolute deviation (%)']];
export const OUTLET_COLUMNS=[['OutletCode','Outlet code'],['OutletName','Outlet name'],['Division','Division'],['RHO','RHO'],['Zonal','Zonal'],['records','Eligible detail rows'],['benchmarkGap','Indicative benchmark gap (BDT)'],['quantity','Quantity'],['amount','Source amount (BDT)'],['maxDeviation','Highest absolute deviation (%)']];
export const ARTICLE_COLUMNS=[['ArticleCode','Article code'],['ArticleName','Article name'],['Category','Category'],['records','Eligible detail rows'],['outlets','Outlets'],['benchmarkGap','Indicative benchmark gap (BDT)'],['quantity','Quantity'],['maxDeviation','Highest absolute deviation (%)']];
export function managementSheets(view,mode,snapshot) {
  const s=view.summary;
  const rows=[['Measure','Value','Context'],['Source report',snapshot.sourceReport,'Published Power BI'],['Source refreshed at',snapshot.sourceTimestamp || 'Not supplied','UTC'],['Snapshot generated at',snapshot.generatedAt,'UTC'],['Mode',mode === 'buy'?'Over buying price':'Under sale price',''],['From date',view.scope.start,'Inclusive'],['To date',view.scope.end,'Inclusive'],['Deviation floor (%)',view.scope.deviationFloor,'Source parameter'],['Quantity floor',view.scope.qtyFloor,'Source parameter'],['Source incidents',s.Incidents,mode === 'buy'?'Day–Outlet–Article':'Outlet–Article'],['Eligible detail rows',view.detail.length,'Source detail values above the source deviation floor'],['Source incident rate',s.IncidentRate ?? '', 'Ratio; no inferred under-sale rate'],['Source unit price',s.UnitPrice,'BDT'],['Source benchmark',s.Benchmark,'BDT'],['Source sale margin',s.SaleMargin ?? s.SourceSaleMargin ?? '', 'Ratio'],['Source average sale margin',s.SourceAvgSaleMargin ?? '', 'Source summary card; rounded by Power BI'],['Indicative benchmark gap',totals(view.detail).benchmarkGap,'Quantity × positive unit difference; not an accounting loss'],['Net sales',s.NetSales,'BDT'],['COGS',s.COGS,'BDT'],['Sales quantity',s.SalesQuantity,'Source quantity'],['Source summary',s.SourceText,'Verbatim public report output'],['Hierarchy source',snapshot.organization.sourceFile,'Current Zone Distribution'],['Hierarchy updated at',snapshot.organization.updatedAt || '', 'UTC'],['Unmapped outlets',new Set(view.detail.filter(r=>r.Mapping !== 'Mapped').map(r=>r.OutletCode)).size,'Retained in totals']];
  return [
    {name:'Management overview',rows},
    sheet('Outlet summary',OUTLET_COLUMNS,groupDetail(view.detail,'OutletCode')),
    sheet('RHO accountability',LEADER_COLUMNS,groupDetail(view.detail,'RHO')),
    sheet('Zonal accountability',LEADER_COLUMNS,groupDetail(view.detail,'Zonal')),
    sheet('Article intelligence',ARTICLE_COLUMNS,groupDetail(view.detail,'ArticleCode')),
    sheet(mode === 'buy'?'Over buying exceptions':'Under sale periodic',DETAIL_COLUMNS,view.detail),
    sheet(mode === 'buy'?'DC comparison':'Under sale daily',DETAIL_COLUMNS,view.supplemental),
    sheet('Daily comparison',[['Date','Date'],['Day','Day label'],['Quantity','Quantity'],['UnitPrice','Source unit price (BDT)'],['Benchmark','Source benchmark (BDT)']],view.trend),
  ];
}
export async function exportManagement(view,mode,snapshot) {return downloadWorkbook(managementSheets(view,mode,snapshot),`SHWAPNO_${mode === 'buy'?'Over_Buying':'Under_Sale'}_Management_${view.scope.end}.xlsx`);}
