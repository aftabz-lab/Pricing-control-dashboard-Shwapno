import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeResult, resourceKey } from '../powerbi.js';
import { normalizeMode, totals } from '../data.js';
import { normalizeOrganization, enrich } from '../organization.js';
import { canReplaceSnapshot, validateSnapshot } from '../snapshot-state.js';
import { csvText, managementSheets } from '../export.js';
import { SETTINGS } from '../settings.js';

const org=normalizeOrganization({rows:[{code:' f240 ',name:'Mugda',division:'Dhaka',leader:'Mr. Shadhin',zonal:'Mr. Aminul'}],savedAt:'2026-10-07T00:00:00Z',fileName:'Zone.xlsx'});
test('Public source key is the requested pricing report',()=>{assert.equal(resourceKey(SETTINGS.reportUrl),'75ef8b89-32cc-42e4-869d-7f688be09807');});
test('DSR decoder respects schema field order, dictionaries, repeat and null masks',()=>{
  const data={descriptor:{Select:[{Name:'Amount',Value:'M0',Kind:2},{Name:'Outlet',Value:'G0',Kind:1}]},dsr:{DS:[{ValueDicts:{D0:['F240','F280']},PH:[{DM0:[{S:[{N:'G0',DN:'D0'},{N:'M0'}],C:[0,'321.6']},{R:1,C:['56.8']},{C:[1], 'Ø':2}]}]}]}};
  assert.deepEqual(decodeResult({result:{data}}),[{Amount:321.6,Outlet:'F240'},{Amount:56.8,Outlet:'F240'},{Amount:null,Outlet:'F280'}]);
});
test('Incomplete Power BI results cannot become a valid empty snapshot',()=>{assert.throws(()=>decodeResult({result:{error:{message:'failed'}}}));assert.throws(()=>decodeResult({result:{data:{dsr:{DataShapes:[{'odata.error':{message:{value:'unknown measure'}}}]}}}}),/unknown measure/);});
test('Both Zone field formats are linked by exact normalised outlet code',()=>{
  const legacy=normalizeOrganization({rows:[{CODE:'F240','Outlet Name':'Mugda',Division:'Dhaka','Regional Head HR Name':'Mr. Shadhin','Zonal HR Name':'Mr. Aminul'}]});
  assert.equal(org.rows[0].RHO,legacy.rows[0].RHO);assert.equal(enrich([{OutletCode:' f240 '}],org)[0].Zonal,'Mr. Aminul');
  const missing=enrich([{OutletCode:'DK14'}],org)[0];assert.equal(missing.Mapping,'Not mapped');assert.equal(missing.OutletCode,'DK14');
});
test('Conflicting owner mappings are shown explicitly rather than silently assigning a leader',()=>{
  const conflict=normalizeOrganization({rows:[{code:'F1',leader:'A',zonal:'X'},{code:'F1',leader:'B',zonal:'X'}]});assert.equal(conflict.rows[0].RHO,'Mapping conflict');assert.equal(enrich([{OutletCode:'F1'}],conflict)[0].Mapping,'Conflict');
});
test('Genuine blank source outlet codes remain in totals and retain their original blank code',()=>{
  const rows=enrich([{OutletCode:null,ArticleCode:'2400955',Quantity:4.33}],org);assert.equal(rows.length,1);assert.equal(rows[0].OutletCode,'Not supplied');assert.equal(rows[0].SourceOutletCode,null);assert.equal(rows[0].Mapping,'Not mapped');assert.equal(enrich(rows,org)[0].OutletCode,'Not supplied');
});
test('Buying source unit prices and exact grain are preserved; gap is computed from source deviation',()=>{
  const source={summary:[{Incidents:1}],summaryText:[{text:'for 1 incidents, the Sale Margin% was 7.1% vs Average Sale Margin% 13.3%'}],detail:[{Day:'Sep 6 Sun',OutletCode:'F240',ArticleNo:'2401005',ArticleName:'Cardinal Alu', 'Cat 3':'ALU','Receiving Qty':2.01,'Receiving Cost':321.6,'Unit Receiving Cost':160,'Avg Unit Receiving Cost':20.61504523284289,'Over Pricing Deviation':139.38495476715713,'Deviation % (Above n)':676.1321801278214}],trend:[]};
  const view=normalizeMode(source,'buy',{start:'2026-09-06',end:'2026-10-06',deviationFloor:5,qtyFloor:2},org,{calendar:[{Day:'Sep 6 Sun',Date:'2026-09-06'}]});
  assert.equal(view.detail[0].UnitPrice,160);assert.equal(view.detail[0].Benchmark,20.61504523284289);assert.equal(view.detail[0].Date,'2026-09-06');assert.ok(Math.abs(totals(view.detail).benchmarkGap-280.1637590819858)<1e-9);
});
test('Periodic under-sale incidents use strict quantity and deviation floors; daily rows remain separate',()=>{
  const base={OutletCode:'F240',ArticleNo:'2400955',ArticleName:'Ada',Quantity:2.64,'Incident Avg Price':10,'National Avg Price':159.8609077213549,'Price Deviation %':-93.74456198044962};
  const raw={summary:[{Incidents:1}],summaryText:[],detail:[base,{...base,ArticleNo:'equal-qty',Quantity:2},{...base,ArticleNo:'equal-floor','Price Deviation %':-5}],daily:[{...base,Quantity:1}],trend:[]};
  const view=normalizeMode(raw,'sale',{start:'2026-09-06',end:'2026-10-06',deviationFloor:5,qtyFloor:2},org);
  assert.equal(view.detail.length,1);assert.equal(view.supplemental.length,1);assert.equal(view.detail[0].UnitPrice,10);assert.equal(view.detail[0].Benchmark,159.8609077213549);
});
function snapshot(generatedAt,end='2026-10-06',sourceTimestamp='2026-10-07T06:49:37Z'){
  const view={scope:{start:'2026-09-06',end,deviationFloor:5,qtyFloor:2},summary:{Incidents:0},detail:[],supplemental:[],trend:[]};
  return {version:1,sourceReport:SETTINGS.reportUrl,generatedAt,sourceTimestamp,organization:org,modes:{buy:structuredClone(view),sale:structuredClone(view)}};
}
test('An older or incomplete published snapshot cannot replace a newer cached snapshot',()=>{
  const current=snapshot('2026-10-07T10:00:00Z');assert.equal(canReplaceSnapshot(snapshot('2026-10-07T09:00:00Z'),current),false);assert.equal(canReplaceSnapshot(snapshot('2026-10-07T11:00:00Z','2026-10-05'),current),false);assert.equal(canReplaceSnapshot(snapshot('2026-10-07T11:00:00Z','2026-10-06','2026-10-06T01:00:00Z'),current),false);assert.equal(canReplaceSnapshot(snapshot('2026-10-07T11:00:00Z'),current),true);assert.throws(()=>validateSnapshot({...current,modes:{buy:current.modes.buy}}));
});
test('Exports keep numeric negative values and quote formula-like source text safely',()=>{const value=csvText([['name','Name'],['value','Value']],[{name:'=SUM(A1)',value:-2.5}]);assert.ok(value.includes("'=SUM(A1)"));assert.ok(value.includes('"-2.5"'));});
test('Management Excel separates source headline, review rows and comparison grain',()=>{
  const view={scope:{start:'2026-09-06',end:'2026-10-06',deviationFloor:5,qtyFloor:2},summary:{Incidents:576,UnitPrice:73.67,Benchmark:73.78},detail:[],supplemental:[],trend:[]};const sheets=managementSheets(view,'sale',snapshot('2026-10-07T10:00:00Z'));
  assert.ok(sheets.some(s=>s.name==='Under sale periodic'));assert.ok(sheets.some(s=>s.name==='Under sale daily'));assert.ok(sheets[0].rows.some(r=>r[0]==='Source incidents'&&r[1]===576));
});
