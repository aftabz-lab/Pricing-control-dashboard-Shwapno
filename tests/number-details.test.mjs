import test from 'node:test';
import assert from 'node:assert/strict';
import {captureContext,metricScenario,groupScenario,rowScenario,ownershipScenario,trendScenario,mappingScenario,scenarioRows,sourceMeasures} from '../number-details.js';
import {groupDetail} from '../export.js';

const rows=[
  {OutletCode:'F001',ArticleCode:'101',RHO:'RHO A',Category:'DAL',Date:'2026-09-06',Quantity:3,DeviationPct:9,BenchmarkGap:12,Mapping:'Mapped'},
  {OutletCode:'F001',ArticleCode:'102',RHO:'RHO A',Category:'DAL',Date:'2026-09-07',Quantity:4,DeviationPct:8,BenchmarkGap:16,Mapping:'Mapped'},
  {OutletCode:'F002',ArticleCode:'103',RHO:'Not mapped',Category:'RICE',Date:'2026-09-06',Quantity:5,DeviationPct:10,BenchmarkGap:20,Mapping:'Not mapped'}
];
const daily=rows.map(r=>({...r,DeviationPct:-25}));
const view={scope:{start:'2026-09-06',end:'2026-10-06'},summary:{Incidents:3,UnitPrice:42},categories:[{Category:'DAL',Incidents:2}],detail:rows,supplemental:daily,trend:[{Date:'2026-09-06',Day:'Sep 6 Sun',UnitPrice:55,Benchmark:56,Quantity:1000}]};
const snapshot={sourceTimestamp:'2026-10-07T12:03:00Z',generatedAt:'2026-10-07T15:05:00Z',organization:{rows:[{OutletCode:'F001'},{OutletCode:'F002'}]},modes:{buy:view,sale:{...view,detail:rows.map(r=>({...r,Date:null}))}}};
const context=mode=>captureContext(snapshot.modes[mode],mode,{...snapshot.modes[mode].scope,rhos:['Applied RHO']},snapshot.organization,snapshot);

test('Source headline stays distinct from review-row count, and draft changes cannot change a captured scope',()=>{
  const view={...snapshot.modes.buy,summary:{...snapshot.modes.buy.summary,Incidents:99999}};
  const applied={start:'2026-09-06',end:'2026-10-06',rhos:['Applied RHO']};
  const c=captureContext(view,'buy',applied,snapshot.organization,snapshot);
  const s=metricScenario(c,{metric:'Incidents',value:view.summary.Incidents,label:'Source incidents',sourceMeasure:true});
  applied.rhos[0]='Unapplied RHO';
  assert.equal(s.value,99999);assert.equal(s.rows.length,view.detail.length);
  assert.deepEqual(c.applied.rhos,['Applied RHO']);
  assert.equal(sourceMeasures(s).find(m=>m.key==='Incidents').value,99999);
});

test('A leader or category number uses only its own contributors; max deviation keeps every tied contributor',()=>{
  const c=context('buy'),leader=groupDetail(c.view.detail,'RHO')[0];
  const s=rowScenario(c,leader,{key:'records',label:'Rows'});
  assert.equal(s.rows.length,leader.records);assert.ok(s.rows.every(r=>r.RHO===leader.Name));
  const category=c.view.categories[0],cat=groupScenario(c,'Category',category.Category,{metric:'incidents',value:category.Incidents,sourceMeasure:true});
  assert.ok(cat.rows.every(r=>r.Category===category.Category));
  assert.equal(sourceMeasures(cat)[0].value,category.Incidents);
  const tied=metricScenario(c,{metric:'maxDeviation',value:9,rows:[{DeviationPct:9},{DeviationPct:-9},{DeviationPct:8}]});
  assert.equal(tied.rows.length,2);
});

test('A daily sale point uses the original daily dataset rather than periodic records, and keeps daily source measures',()=>{
  const c=context('sale'),point=c.view.trend[0],s=trendScenario(c,point,'UnitPrice');
  assert.equal(s.dataset,'supplemental');assert.ok(s.rows.every(r=>r.Date===point.Date));
  assert.equal(s.value,point.UnitPrice);
  assert.equal(sourceMeasures(s).find(m=>m.key==='Quantity').value,point.Quantity);
  const raw=c.view.supplemental[0],row=rowScenario(c,raw,{key:'UnitPrice',label:'Price'},'supplemental');
  assert.deepEqual(row.rows,[raw]);assert.equal(row.dataset,'supplemental');
});

test('Mapped/unmapped outlet lists and the published mapping list match their displayed counts',()=>{
  const c=context('buy');
  for(const part of ['mapped','unmapped','all']){
    const s=ownershipScenario(c,part);assert.equal(scenarioRows(s).length,s.value);
    if(part==='mapped')assert.ok(s.rows.every(r=>r.Mapping==='Mapped'));
    if(part==='unmapped')assert.ok(s.rows.every(r=>r.Mapping!=='Mapped'));
  }
  const s=mappingScenario(c);assert.equal(s.rows.length,snapshot.organization.rows.length);
});
