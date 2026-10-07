import { SETTINGS } from './settings.js';
import { PricingClient } from './powerbi.js';
import { loadOrganization, enrich } from './organization.js';
import { loadMode, totals, groupRows } from './data.js';
import { validateSnapshot, canReplaceSnapshot } from './snapshot-state.js';
import { exportManagement, saveCsv, groupDetail, LEADER_COLUMNS, OUTLET_COLUMNS, ARTICLE_COLUMNS, DETAIL_COLUMNS } from './export.js';
import { captureContext, metricScenario, groupScenario, rowScenario, ownershipScenario, trendScenario, mappingScenario, scenarioRows, scenarioTotals, sourceMeasures } from './number-details.js';

const $=selector=>document.querySelector(selector);
const $$=selector=>[...document.querySelectorAll(selector)];
const esc=value=>String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const number=(value,digits=0)=>Number.isFinite(value)?new Intl.NumberFormat('en-GB',{maximumFractionDigits:digits,minimumFractionDigits:digits}).format(value):'—';
const money=value=>!Number.isFinite(value)?'—':Math.abs(value)>=1e7?number(value/1e7,2)+' Cr':Math.abs(value)>=1e5?number(value/1e5,2)+' Lakh':number(value);
const date=value=>value?new Date(value+'T00:00:00Z').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}):'—';
const timestamp=value=>value?new Date(value).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Dhaka'})+' GMT+6':'Not supplied';
const pct=value=>Number.isFinite(value)?number(value*100,2)+'%':'—';
const paths={overview:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',people:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M22 21v-2a4 4 0 0 0-3-3.8 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M16 3.1a4 4 0 0 1 0 7.8',store:'M3 10v11h18V10 M2 10l2-7h16l2 7 M2 10h20 M9 21v-7h6v7',box:'M12 3l9 5v9l-9 5-9-5V8z M3 8l9 5 9-5 M12 13v9 M7.5 5.5l9 5',layers:'M12 3l10 6-10 6L2 9z M2 13l10 6 10-6 M2 17l10 6 10-6',clock:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2',menu:'M3 6h18 M3 12h18 M3 18h18',sun:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',moon:'M20.8 13a9 9 0 1 1-9.8-9.8A7 7 0 0 0 20.8 13',refresh:'M21 3v6h-6 M3 21v-6h6 M3.8 9A9 9 0 0 1 18.7 4L21 9 M3 15l2.3 5a9 9 0 0 0 14.9-5',download:'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5',filter:'M3 5h18 M6 12h12 M10 19h4',close:'M5 5l14 14 M19 5L5 19',shield:'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6',trend:'M3 17l6-6 4 4 8-10 M15 5h6v6',link:'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2'};
const icon=name=>`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.box}"></path></svg>`;
function icons(){ $$('[data-icon]').forEach(node=>{node.innerHTML=icon(node.dataset.icon);}); }
const views={overview:['Executive overview','See the exposure. Find the owner. Review the exception.'],leaders:['RHO & Zonal accountability','A clear view of the leaders responsible for each outlet.'],outlets:['Outlet exceptions','Prioritise outlet review using the source price comparisons.'],articles:['Article intelligence','Understand which articles drive the benchmark gap.'],supplemental:['DC comparison','Separate source comparisons for distribution centres.'],source:['Snapshot & calculation rules','Source freshness, ownership mapping and calculation definitions.']};
const cacheKey='shwapno-pricing-control-snapshot-v1';
const state={mode:'buy',view:'overview',snapshot:null,current:null,filters:null,applied:null,client:null,tableStates:new Map(),tables:new Map(),busy:false,request:0,focusReturn:null};
state.numberLinks=new Map();
const drawerState={numberLinks:new Map(),tableStates:new Map(),tables:new Map(),scenario:null,history:[]};
function numberLink(text,scenario,target=state){
  if(!Number.isFinite(scenario.value))return esc(text);
  const id=(target===state?'main':'drawer')+'-'+target.numberLinks.size;
  target.numberLinks.set(id,{...scenario,display:String(text)});
  return `<button type="button" class="number-link" data-number-link="${id}" aria-haspopup="dialog" aria-controls="detailDrawer" aria-label="View ${esc(scenario.label)} details${scenario.entity?' for '+esc(scenario.entity):''}" title="View ${esc(scenario.title)} details">${esc(text)}</button>`;
}
function numberContext(){return captureContext(state.current,state.mode,state.applied,state.snapshot.organization,state.snapshot);}
function defaults(){const s=state.snapshot.modes[state.mode].scope;return {start:s.start,end:s.end,period:'source',masterCategories:[...(s.masterCategories || ['LOOSE COMMODITY'])],deviationFloor:s.deviationFloor,qtyFloor:s.qtyFloor,regions:[],rhos:[],zonals:[],outlets:[],articles:[],categories:[],movements:[],purchaseTypes:[]};}
function isDefault(f){const d=defaults();return f.start===d.start && f.end===d.end && f.deviationFloor===d.deviationFloor && f.qtyFloor===d.qtyFloor && ['regions','rhos','zonals','outlets','articles','categories','movements','purchaseTypes'].every(k=>!f[k].length) && JSON.stringify([...f.masterCategories].sort())===JSON.stringify(d.masterCategories);}
function notice(message){$('#notice').textContent=message;$('#notice').hidden=!message;}
function setBusy(value){state.busy=value;for(const id of ['refreshButton','applyButton','quickApply','excelButton'])$('#'+id).disabled=value;$('#applyButton').textContent=value?'Reading source…':'Apply review scope';}
function status(label,when,kind=''){ $('#snapshotLabel').textContent=label;$('#snapshotTime').textContent=when;$('#snapshotDot').className='status-dot'+(kind?' '+kind:''); }
function updateHeaderSnapshotTime(){
  const node=$('#headerSnapshotTime'),value=state.snapshot?.generatedAt,when=new Date(value);
  if(!value||!Number.isFinite(when.getTime())){node.textContent='—';node.removeAttribute('datetime');node.removeAttribute('title');return;}
  node.setAttribute('datetime',value);node.title='Snapshot taken '+timestamp(value);
  const day=when.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Dhaka'});
  const clock=when.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:'Asia/Dhaka'});
  node.innerHTML='<span class="header-snapshot-date">'+esc(day)+'</span><span class="header-snapshot-clock">'+esc(clock)+' GMT+6</span>';
}
function statusCurrent(){updateHeaderSnapshotTime();status(isDefault(state.applied)?'Shared Power BI snapshot':'Filtered Power BI view',`Power BI refreshed ${timestamp(state.snapshot.sourceTimestamp)} · Snapshot ${timestamp(state.snapshot.generatedAt)}`);}
function rangeText(v){return date(v.scope.start)+' – '+date(v.scope.end);}
function counter(){const f=state.filters;let n=Object.entries(f).filter(([k,v])=>Array.isArray(v)&&(k==='masterCategories'?JSON.stringify(v)!==JSON.stringify(defaults().masterCategories):v.length)).length;if(f.period!=='source')n++;if(f.deviationFloor!==defaults().deviationFloor||f.qtyFloor!==defaults().qtyFloor)n++;$('#filterCount').textContent=n?n+' active filter'+(n>1?'s':''):'Source defaults';$('#filterHint').innerHTML=JSON.stringify(state.filters)===JSON.stringify(state.applied)?`${numberLink(number(state.snapshot.organization.rows.length),mappingScenario(numberContext()))} outlet mappings · RHO and Zonal from Zone Distribution`:'Selection changed. Apply scope to update every figure and table.';}
function fieldOptions(key){
  const org=state.snapshot.organization.rows,dim=state.snapshot.dimensions || {},f=state.filters;
  let linked=org.filter(r=>(!f.regions.length||f.regions.includes(r.Division))&&(!f.rhos.length||key==='rhos'||f.rhos.includes(r.RHO))&&(!f.zonals.length||key==='zonals'||f.zonals.includes(r.Zonal)));
  let options=[];
  if (['regions','rhos','zonals'].includes(key)){const col={regions:'Division',rhos:'RHO',zonals:'Zonal'}[key];const source=key==='regions'?org:linked;options=[...new Set(source.map(r=>r[col]).filter(Boolean))].sort().map(v=>({value:v,label:v}));if(key!=='regions')options.push({value:'Not mapped',label:'Not mapped'});}
  if(key==='outlets'){const map=new Map(linked.map(r=>[r.OutletCode,r]));options=(dim.outlets||state.snapshot.organization.rows).filter(r=>!f.rhos.length&&!f.zonals.length&&!f.regions.length||map.has(r.OutletCode)).map(r=>({value:r.OutletCode,label:r.OutletCode+' — '+r.OutletName})).sort((a,b)=>a.value.localeCompare(b.value));}
  if(key==='masterCategories')options=[...new Set((dim.articles||[]).map(r=>r.MasterCategory).filter(Boolean))].sort().map(v=>({value:v,label:v}));
  if(key==='categories'||key==='articles'){
    const articles=(dim.articles||[]).filter(r=>(!f.masterCategories.length||f.masterCategories.includes(r.MasterCategory))&&(key==='categories'||!f.categories.length||f.categories.includes(r.Subcategory)));
    options=key==='categories'?[...new Set(articles.map(r=>r.Subcategory).filter(Boolean))].sort().map(v=>({value:v,label:v})):articles.map(r=>({value:r.ArticleCode,label:r.ArticleCode+' — '+r.ArticleName}));
  }
  if(key==='movements'||key==='purchaseTypes')options=(dim[key] || []).map(v=>({value:String(v),label:String(v)}));
  const map=new Map(options.map(o=>[o.value,o]));f[key].forEach(v=>{if(!map.has(v))map.set(v,{value:v,label:v});});return [...map.values()];
}
function selectionLabel(key){const list=state.filters[key];if(!list.length)return 'All '+({rhos:'RHO',zonals:'Zonal',masterCategories:'categories',purchaseTypes:'purchase types',regions:'divisions',categories:'subcategories',outlets:'outlets',articles:'articles',movements:'movements'}[key]);if(list.length===1){const o=fieldOptions(key).find(o=>o.value===list[0]);return o?.label || list[0];}return list.length+' selected';}
function renderFilterOptions(node){
  const key=node.dataset.filter,q=node.querySelector('.multi-search').value.toLocaleLowerCase(),all=fieldOptions(key),visible=all.filter(o=>o.label.toLocaleLowerCase().includes(q));
  node._visible=visible;
  node.querySelector('.multi-options').innerHTML=visible.slice(0,150).map(o=>`<label class="multi-option"><input type="checkbox" data-value="${esc(o.value)}" ${state.filters[key].includes(o.value)?'checked':''}><span>${esc(o.label)}</span></label>`).join('') || '<p class="drawer-hint">No matching options.</p>';
  node.querySelector('.multi-summary').textContent=`${number(visible.length)} match${visible.length===1?'':'es'} · ${state.filters[key].length} selected${visible.length>150?' · first 150 shown':''}`;
}
function updateFilterLabels(){for(const node of $$('.multi-filter')){const label=selectionLabel(node.dataset.filter);node.querySelector('.selected-text').textContent=label;node.querySelector('.multi-toggle').title=label;if(!node.querySelector('.multi-popover').hidden)renderFilterOptions(node);}counter();}
function closePopovers(){for(const node of $$('.multi-filter')){node.querySelector('.multi-popover').hidden=true;node.querySelector('.multi-toggle').setAttribute('aria-expanded','false');}}
function initFilters(){
  for(const node of $$('.multi-filter')){
    const key=node.dataset.filter,label=node.dataset.label;
    node.innerHTML=`<span class="filter-label" id="${key}Label">${esc(label)}</span><button class="multi-toggle" aria-labelledby="${key}Label" aria-haspopup="dialog" aria-expanded="false" aria-controls="${key}Popover"><span class="selected-text">All</span><span>⌄</span></button><div class="multi-popover" id="${key}Popover" role="dialog" aria-label="${esc(label)} selections" hidden><input class="multi-search" type="search" placeholder="Type to search" aria-label="Search ${esc(label)}"><div class="multi-actions"><button class="text-button" data-action="matching">Select all matching</button><button class="text-button" data-action="clear">All / clear</button></div><div class="multi-options" role="group" aria-label="Available options"></div><div class="multi-summary"></div></div>`;
    node.querySelector('.multi-toggle').addEventListener('click',()=>{const open=!node.querySelector('.multi-popover').hidden;closePopovers();if(!open){node.querySelector('.multi-popover').hidden=false;node.querySelector('.multi-toggle').setAttribute('aria-expanded','true');renderFilterOptions(node);node.querySelector('.multi-search').focus();}});
    node.querySelector('.multi-search').addEventListener('input',()=>renderFilterOptions(node));
    node.querySelector('.multi-search').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();state.filters[key]=[...new Set([...state.filters[key],...node._visible.map(v=>v.value)])];updateFilterLabels();}});
    node.addEventListener('change',event=>{const value=event.target.dataset.value;if(value==null)return;state.filters[key]=event.target.checked?[...new Set([...state.filters[key],value])]:state.filters[key].filter(v=>v!==value);updateFilterLabels();});
    node.querySelector('[data-action=matching]').addEventListener('click',()=>{state.filters[key]=[...new Set([...state.filters[key],...node._visible.map(v=>v.value)])];updateFilterLabels();});
    node.querySelector('[data-action=clear]').addEventListener('click',()=>{state.filters[key]=[];updateFilterLabels();});
  }
  document.addEventListener('click',event=>{if(!event.target.closest('.multi-filter'))closePopovers();});
}
function syncControls(){const f=state.filters;$('#period').value=f.period;$('#dateFrom').value=f.start;$('#dateTo').value=f.end;$('#deviationFloor').value=f.deviationFloor;$('#qtyFloor').value=f.qtyFloor;updateFilterLabels();}
function readControls(){state.filters.start=$('#dateFrom').value;state.filters.end=$('#dateTo').value;state.filters.deviationFloor=Number($('#deviationFloor').value);state.filters.qtyFloor=Number($('#qtyFloor').value);counter();}
function territoryOutlets(f,organization=state.snapshot.organization){
  if(!f.rhos.length&&!f.zonals.length)return f.outlets;
  const rows=enrich(state.snapshot.dimensions.outlets,organization);
  return rows.filter(r=>(!f.rhos.length||f.rhos.includes(r.RHO))&&(!f.zonals.length||f.zonals.includes(r.Zonal))&&(!f.regions.length||f.regions.includes(r.Division))&&(!f.outlets.length||f.outlets.includes(r.OutletCode))).map(r=>r.OutletCode);
}
async function applyScope(){
  if(state.busy)return;readControls();const f=structuredClone(state.filters);
  if(!f.start||!f.end||f.start>f.end){notice('Choose a valid date range with the from date before the to date.');return;}
  if(!Number.isFinite(f.deviationFloor)||f.deviationFloor<0||f.deviationFloor>100||!Number.isFinite(f.qtyFloor)||f.qtyFloor<0){notice('Enter a deviation floor from 0 to 100 and a quantity floor of zero or more.');return;}
  closePopovers();notice('');setBusy(true);const request=++state.request;
  try{
    let view;
    if(isDefault(f))view=state.snapshot.modes[state.mode];
    else {
      const outlets=territoryOutlets(f);
      if((f.rhos.length||f.zonals.length)&&!outlets.length)throw new Error('No outlets match this RHO / Zonal selection. Clear or change the selection.');
      status('Reading filtered Power BI view','The same source measures are queried in the selected context.','pending');
      state.client ||= await new PricingClient().connect();
      view=await loadMode(state.client,state.mode,{...f,outlets},state.snapshot.organization,state.snapshot.dimensions);
    }
    if(request!==state.request)return;
    state.current=view;state.applied=f;state.tableStates.clear();render();statusCurrent();counter();
  }catch(error){state.filters=structuredClone(state.applied);syncControls();statusCurrent();notice(error.message+' The last valid view has been retained.');}
  finally{if(request===state.request)setBusy(false);}
}
function header(title,subtitle,extra=''){return `<div class="section-head"><div><span class="eyebrow">${esc(subtitle)}</span><h2>${esc(title)}</h2></div>${extra}</div>`;}
function kpis(){
  const v=state.current,s=v.summary,t=totals(v.detail),margin=s.SaleMargin ?? s.SourceSaleMargin,c=numberContext();
  const link=(key,label,display,value=s[key],source=true,presentation='details')=>numberLink(display,metricScenario(c,{metric:key,label,value,sourceMeasure:source,presentation}));
  return '<div class="kpi-grid">'+
  '<article class="kpi hero panel"><div class="kpi-label">'+(state.mode==='buy'?'Over-buying':'Under-sale')+' incidents <span class="badge '+(state.mode==='buy'?'amber':'clay')+'">SOURCE HEADLINE</span></div><div class="kpi-value">'+link('Incidents','Source incidents',number(s.Incidents))+'</div><p class="kpi-note">'+(state.mode==='buy'?'Day · Outlet · Article':'Outlet · Article')+'<br>'+link('records','Eligible detail rows',number(v.detail.length),v.detail.length,false)+' eligible detail rows</p></article>'+
  '<article class="kpi panel"><div class="kpi-label">Indicative benchmark gap '+icon('trend')+'</div><div class="kpi-value amber">'+link('benchmarkGap','Indicative benchmark gap',money(t.benchmarkGap),t.benchmarkGap,false)+'</div><p class="kpi-note">BDT · quantity × unit difference<br>Above / below source benchmark</p></article>'+
  '<article class="kpi panel"><div class="kpi-label">Outlets to review '+icon('store')+'</div><div class="kpi-value">'+link('outlets','Outlets to review',number(t.outlets),t.outlets,false,'outlets')+'</div><p class="kpi-note">'+link('articles','Articles in scope',number(t.articles),t.articles,false,'articles')+' articles in scope<br>Linked to RHO &amp; Zonal</p></article>'+
  '<article class="kpi panel"><div class="kpi-label">Source sale margin '+icon('shield')+'</div><div class="kpi-value '+(margin<s.SourceAvgSaleMargin?'amber':'cool')+'">'+link('SaleMargin','Source sale margin',pct(margin),margin)+'</div><p class="kpi-note">Average sale margin <strong>'+link('SourceAvgSaleMargin','Average sale margin',pct(s.SourceAvgSaleMargin))+'</strong><br>Power BI source calculation</p></article>'+
  '<article class="kpi panel"><div class="kpi-label">'+(state.mode==='buy'?'Source incident rate':'Source average price')+' '+icon('box')+'</div><div class="kpi-value">'+(state.mode==='buy'?link('IncidentRate','Source incident rate',pct(s.IncidentRate)):link('UnitPrice','Source average price',number(s.UnitPrice,2)))+'</div><p class="kpi-note">'+(state.mode==='buy'?'Source unit cost '+link('UnitPrice','Source unit cost',number(s.UnitPrice,2)):'National benchmark '+link('Benchmark','National benchmark',number(s.Benchmark,2)))+'<br>'+(state.mode==='buy'?'Benchmark '+link('Benchmark','Source benchmark',number(s.Benchmark,2)):'BDT · source price measure')+'</p></article></div>';
}
function trendChart(){
  const rows=state.current.trend.filter(r=>r.UnitPrice!=null||r.Benchmark!=null),w=620,h=178,left=43,right=8,top=13,bottom=27;
  if(!rows.length)return '<p class="drawer-hint">No daily comparison is available for this scope.</p>';
  const prices=rows.flatMap(r=>[r.UnitPrice,r.Benchmark]).filter(Number.isFinite),min=Math.min(...prices),max=Math.max(...prices),pad=Math.max((max-min)*.18,2),lo=Math.max(0,min-pad),hi=max+pad;
  const x=i=>left+(w-left-right)*i/Math.max(1,rows.length-1),y=v=>top+(h-top-bottom)*(1-(v-lo)/(hi-lo));
  const maxQ=Math.max(...rows.map(r=>r.Quantity||0),1),barW=Math.max(2,(w-left-right)/rows.length*.5);
  let svg=`<svg class="chart-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="Daily source unit price and benchmark; muted columns show relative daily quantity">`;
  for(let i=0;i<4;i++){const v=lo+(hi-lo)*i/3;svg+=`<line class="grid-line" x1="${left}" x2="${w-right}" y1="${y(v)}" y2="${y(v)}"/><text x="${left-9}" y="${y(v)+3}" text-anchor="end">${number(v)}</text>`;}
  rows.forEach((r,i)=>{const bh=(h-top-bottom)*.43*(r.Quantity||0)/maxQ;svg+=`<rect ${svgNumberLink(r,'Quantity')} class="quantity-bar" x="${x(i)-barW/2}" y="${h-bottom-bh}" width="${barW}" height="${bh}" opacity=".55"><title>${esc(r.Day)} · Quantity ${number(r.Quantity,2)}</title></rect>`;});
  for(const [key,cls] of [['Benchmark','benchmark-line'],['UnitPrice','actual-line']]){let d='';let gap=true;rows.forEach((r,i)=>{if(Number.isFinite(r[key])){d+=`${gap?'M':'L'}${x(i).toFixed(1)},${y(r[key]).toFixed(1)} `;gap=false;}else gap=true;});svg+=`<path class="${cls}" d="${d}"/>`;}
  rows.forEach((r,i)=>{if(Number.isFinite(r.Benchmark))svg+=`<circle ${svgNumberLink(r,'Benchmark')} class="benchmark-hit" cx="${x(i)}" cy="${y(r.Benchmark)}" r="7"><title>${esc(r.Day)} · Benchmark ${number(r.Benchmark,2)} · Open details</title></circle>`;});
  rows.forEach((r,i)=>{if(Number.isFinite(r.UnitPrice))svg+=`<circle ${svgNumberLink(r,'UnitPrice')} class="marker" cx="${x(i)}" cy="${y(r.UnitPrice)}" r="2.5"><title>${esc(r.Day)} · Price ${number(r.UnitPrice,2)} · Benchmark ${number(r.Benchmark,2)}</title></circle>`;});
  const indices=[...new Set([0,Math.round((rows.length-1)/3),Math.round((rows.length-1)*2/3),rows.length-1])];indices.forEach(i=>{svg+=`<text x="${x(i)}" y="${h-5}" text-anchor="${i===0?'start':i===rows.length-1?'end':'middle'}">${esc(rows[i].Date?date(rows[i].Date).replace(/ \d{4}$/,''):rows[i].Day)}</text>`;});
  return svg+'</svg>';
}
function ranks(items,kind='incidents',drill=null,scopeKey=drill){
  const max=Math.max(...items.map(r=>Number(r[kind])||0),1),c=numberContext();
  const scenario=(r,metric,value,label)=>groupScenario(c,scopeKey,r.Name,{metric,value,label,sourceMeasure:kind==='incidents'&&metric==='incidents'});
  return '<div class="rank-list">'+items.slice(0,5).map(r=>'<div class="rank-item"><span class="rank-label">'+(drill?'<button class="row-link" data-drill-key="'+esc(drill)+'" data-drill="'+esc(r.Name)+'">'+esc(r.Name)+'</button>':esc(r.Name))+'</span><span class="rank-number">'+numberLink(kind==='benchmarkGap'?money(r[kind]):number(r[kind]),scenario(r,kind,r[kind],kind==='benchmarkGap'?'Indicative benchmark gap':'Source category incidents'))+'</span><div class="rank-track"><span style="width:'+Math.max(2,r[kind]/max*100)+'%"></span></div>'+(r.records!=null?'<span class="rank-sub">'+numberLink(number(r.records),scenario(r,'records',r.records,'Eligible detail rows'))+' detail rows · '+numberLink(number(r.outlets),scenario(r,'outlets',r.outlets,'Outlets'))+' outlets</span>':'')+'</div>').join('')+'</div>';
}
function scopeNote(){
  const rows=state.current.detail,codes=new Set(rows.map(r=>r.OutletCode)),mapped=new Set(rows.filter(r=>r.Mapping==='Mapped').map(r=>r.OutletCode)),coverage=codes.size?mapped.size/codes.size*100:0,c=numberContext();
  return '<div class="summary-strip"><div class="panel scope-note">'+icon('shield')+'<div><strong>Source rules, clearly separated</strong><p>The headline uses Power BI’s incident measure. Review rows keep the source price and benchmark at '+(state.mode==='buy'?'day–outlet–article':'outlet–article')+' level. The benchmark gap is indicative and is not an accounting loss.'+(state.current.summary.Incidents!==rows.length?' Source headline and eligible detail rows differ in this filter context.':'')+'</p></div></div><div class="panel scope-note ownership-stat"><span class="ownership-number cool">'+numberLink(number(coverage,1)+'%',ownershipScenario(c))+'</span><div style="flex:1"><strong>Outlet ownership connected</strong><p>'+numberLink(number(mapped.size),ownershipScenario(c,'mapped'))+' of '+numberLink(number(codes.size),ownershipScenario(c,'all'))+' outlets have RHO / Zonal mapping.<br>'+numberLink(number(codes.size-mapped.size),ownershipScenario(c,'unmapped'))+' unmapped outlets remain in totals.</p><div class="progress-track"><span style="width:'+coverage+'%"></span></div></div></div></div>';
}
function numericCell(value,type){if(!Number.isFinite(value))return '—';return type==='money'?money(value):type==='pct'?number(value,2)+'%':type==='ratio'?pct(value):type==='quantity'?number(value,2):number(value);}
function table(id,title,subtitle,columns,rows,kind='outlet',limit=null,target=state,dataset='detail',context=null){
  const c=context || numberContext(),t=target.tableStates.get(id)||{sort:'benchmarkGap',dir:-1,search:'',page:1};target.tableStates.set(id,t);
  const sorted=rows.filter(r=>!t.search||columns.some(col=>String(r[col.key]??'').toLowerCase().includes(t.search.toLowerCase()))).sort((a,b)=>{const av=a[t.sort],bv=b[t.sort];if(av==null)return bv==null?0:1;if(bv==null)return -1;return t.dir*(typeof av==='number'&&typeof bv==='number'?av-bv:String(av).localeCompare(String(bv)));});
  const pageSize=limit || 50,pages=Math.max(1,Math.ceil(sorted.length/pageSize));t.page=Math.max(1,Math.min(t.page,pages));
  const shown=sorted.slice((t.page-1)*pageSize,t.page*pageSize);target.tables.set(id,{columns,rows:sorted,title,dataset,context:c});
  const matching=sorted.flatMap(r=>Array.isArray(r.rows)?r.rows:[r]),countScenario=dataset==='trend'?metricScenario(c,{rows:sorted,dataset:'trend',metric:'trendPoints',value:sorted.length,label:title+' points',presentation:'trend',trend:sorted[0] || null,sourceMeasure:true}):metricScenario(c,{rows:matching,dataset,metric:kind==='outlet'?'outlets':kind==='article'?'articles':'records',value:sorted.length,label:title+' results',presentation:kind==='outlet'?'outlets':kind==='article'?'articles':dataset==='organization'?'organization':'details',note:t.search?'Table search: '+t.search:''});
  let html='<section class="panel table-panel" data-table="'+id+'">'+header(title,subtitle,'<span class="pill">'+numberLink(number(sorted.length),countScenario,target)+' '+(kind==='detail'?'rows':'results')+'</span>')+'<div class="table-tools"><input class="table-search" type="search" aria-label="Search '+esc(title)+'" placeholder="Search outlet, article or owner" value="'+esc(t.search)+'"><div class="table-tool-actions"><span class="pill">Sorted by '+esc(columns.find(col=>col.key===t.sort)?.label || 'benchmark gap')+' '+(t.dir>0?'↑':'↓')+'</span><button class="button" data-csv="'+id+'">'+esc(kind==='leader'?'Leader':kind==='article'?'Article':kind==='detail'?'Detail':'Outlet')+' CSV</button></div></div><div class="table-wrap"><table '+(kind==='leader'?'class="leader-table"':'')+'><caption class="sr-only">'+esc(title)+'</caption><thead><tr>'+columns.map(col=>'<th class="'+(col.numeric?'numeric':'')+'" aria-sort="'+(t.sort===col.key?(t.dir>0?'ascending':'descending'):'none')+'"><button data-sort="'+esc(col.key)+'">'+esc(col.label)+'<span class="sort-arrow" aria-hidden="true">'+(t.sort===col.key?(t.dir>0?'↑':'↓'):'↕')+'</span></button></th>').join('')+'</tr></thead><tbody>';
  html+=shown.map(r=>'<tr>'+columns.map(col=>'<td class="'+(col.numeric?'numeric':'')+'">'+(col.drill?'<button class="row-link" data-drill-key="'+esc(col.drill)+'" data-drill="'+esc(r[col.key])+'">'+esc(r[col.key])+'</button>':col.numeric?numberLink(numericCell(r[col.key],col.type),(dataset==='trend'?trendScenario(c,r,col.key):rowScenario(c,r,col,dataset)),target):esc(r[col.key] ?? '—'))+(col.secondary?'<span class="cell-secondary">'+esc(r[col.secondary])+'</span>':'')+'</td>').join('')+'</tr>').join('');
  html+='</tbody></table>'+(!shown.length?'<div class="table-empty">No results match this scope.</div>':'')+'</div><div class="pager"><span>'+(sorted.length?number((t.page-1)*pageSize+1)+'–'+number(Math.min(t.page*pageSize,sorted.length)):'0')+' of '+numberLink(number(sorted.length),countScenario,target)+' · First two columns frozen</span><div><button data-page="-1" '+(t.page<=1?'disabled':'')+'>← Previous</button><span>'+t.page+' / '+pages+'</span><button data-page="1" '+(t.page>=pages?'disabled':'')+'>Next →</button></div></div></section>';
  return html;
}
const outletColumns=[{key:'OutletCode',label:'Outlet code',drill:'OutletCode'},{key:'OutletName',label:'Outlet name',secondary:'Division'},{key:'RHO',label:'RHO',drill:'RHO'},{key:'Zonal',label:'Zonal',drill:'Zonal'},{key:'records',label:'Detail rows',numeric:true},{key:'benchmarkGap',label:'Benchmark gap · BDT',numeric:true,type:'money'},{key:'quantity',label:'Quantity',numeric:true,type:'quantity'},{key:'maxDeviation',label:'Max deviation',numeric:true,type:'pct'}];
const leaderColumns=key=>[{key:'Name',label:key,drill:key},{key:'outlets',label:'Outlets',numeric:true},{key:'records',label:'Detail rows',numeric:true},{key:'articles',label:'Articles',numeric:true},{key:'benchmarkGap',label:'Benchmark gap · BDT',numeric:true,type:'money'},{key:'quantity',label:'Quantity',numeric:true,type:'quantity'},{key:'maxDeviation',label:'Max deviation',numeric:true,type:'pct'}];
const articleColumns=[{key:'ArticleCode',label:'Article code',drill:'ArticleCode'},{key:'ArticleName',label:'Article name',secondary:'Category'},{key:'records',label:'Detail rows',numeric:true},{key:'outlets',label:'Outlets',numeric:true},{key:'benchmarkGap',label:'Benchmark gap · BDT',numeric:true,type:'money'},{key:'quantity',label:'Quantity',numeric:true,type:'quantity'},{key:'maxDeviation',label:'Max deviation',numeric:true,type:'pct'}];
const detailColumns=(dated=false)=>[{key:'OutletCode',label:'Outlet code',drill:'OutletCode'},{key:'OutletName',label:'Outlet name'},...(state.mode==='buy'||dated?[{key:'Date',label:'Date',secondary:'Day'}]:[]),{key:'ArticleCode',label:'Article code',drill:'ArticleCode'},{key:'ArticleName',label:'Article name'},{key:'RHO',label:'RHO'},{key:'Zonal',label:'Zonal'},{key:'Quantity',label:'Quantity',numeric:true,type:'quantity'},{key:'UnitPrice',label:state.mode==='buy'?'Unit cost':'Unit sale price',numeric:true,type:'quantity'},{key:'Benchmark',label:'Source benchmark',numeric:true,type:'quantity'},{key:'DeviationPct',label:'Deviation',numeric:true,type:'pct'},{key:'BenchmarkGap',label:'Benchmark gap · BDT',numeric:true,type:'money'}];
function renderSource(){const snap=state.snapshot,v=state.current;const row=(a,b)=>`<div class="rule-row"><dt>${esc(a)}</dt><dd>${esc(b)}</dd></div>`;return `<div class="two-column"><section class="panel rules-panel">${header('Freshness & snapshot','AUTOMATED SOURCE CONNECTION')}<dl class="rule-list">${row('Power BI refreshed',timestamp(snap.sourceTimestamp))}${row('Snapshot generated',timestamp(snap.generatedAt))}${row('Data window',rangeText(v))}${row('Source watcher','Every minute · change-triggered rebuild')}${row('Safety rebuild','Every hour')}${row('GitHub fallback','Every five minutes')}${row('Open-page refresh','Every minute · newest validated snapshot')}${row('Last known good','Kept if a source request or validation fails')}</dl><p>The separate Apps Script watcher must be installed. Detection is followed by GitHub’s queue, snapshot build and Pages deployment; timing depends on those services.</p></section><section class="panel rules-panel">${header('Ownership & definitions','CURRENT ZONE DISTRIBUTION')}<dl class="rule-list">${row('Hierarchy file',snap.organization.sourceFile)}${row('Hierarchy updated',timestamp(snap.organization.updatedAt))}${'<div class="rule-row"><dt>Outlet mappings</dt><dd>'+numberLink(number(snap.organization.rows.length),mappingScenario(numberContext()))+'</dd></div>'}${row('Linking rule','Exact outlet code, normalised to uppercase')}${row('Unmapped outlets','Retained and labelled Not mapped')}${row('Incident level',state.mode==='buy'?'Day–Outlet–Article':'Outlet–Article over selected period')}${'<div class="rule-row"><dt>Deviation floor</dt><dd>'+numberLink(v.scope.deviationFloor+'%',metricScenario(numberContext(),{metric:'deviationFloor',value:v.scope.deviationFloor,label:'Source deviation floor'}))+'</dd></div>'}${'<div class="rule-row"><dt>Quantity floor</dt><dd>'+numberLink(number(v.scope.qtyFloor),metricScenario(numberContext(),{metric:'qtyFloor',value:v.scope.qtyFloor,label:'Strict source quantity floor'}))+'</dd></div>'}</dl><p>Prices, benchmarks and margins come from the Power BI measures. Benchmark gap = quantity × positive source unit difference. Leader and outlet summaries aggregate eligible detail rows; missing values remain blank.</p></section></div><section class="panel rules-panel">${header('What Power BI says','SOURCE SUMMARY IN THIS SCOPE')}<div class="source-text">${sourceTextLinks(v.summary.SourceText)}</div><p>${state.mode==='buy'?'DC comparisons keep the original DC table’s DK11 / DK14 and positive receiving quantity rules; they are separate from the outlet exception headline.':'Daily detail keeps the source table’s fixed deviation below −20% filter. Periodic incidents use the selected deviation floor at Outlet–Article level; daily rows are separate.'}</p><p><a href="${esc(SETTINGS.reportUrl)}" target="_blank" rel="noopener">Open source Power BI report ↗</a> &nbsp; · &nbsp; <a href="${esc(SETTINGS.zoneDashboardUrl)}" target="_blank" rel="noopener">Open Zone Distribution ↗</a></p></section>`;}
function render(){
  if(!state.current)return;state.tables.clear();state.numberLinks.clear();const v=state.current,rows=v.detail,all=groupDetail(rows,'OutletCode');
  $('#pageTitle').textContent=state.view==='supplemental'?(state.mode==='buy'?'DC comparison':'Daily under-sale exceptions'):views[state.view][0];$('#pageSubtitle').textContent=state.view==='supplemental'?(state.mode==='buy'?'Original distribution-centre comparisons, shown separately from outlet incidents.':'Original daily detail below −20%, separate from periodic incidents.'):views[state.view][1];
  $('#dateWindow').textContent=rangeText(v);$('#grainLabel').textContent=state.mode==='buy'?'Day · Outlet · Article':'Outlet · Article';$('#supplementalNav').textContent=state.mode==='buy'?'DC comparison':'Daily under-sale detail';
  $$('.nav-item').forEach(n=>{n.classList.toggle('active',n.dataset.view===state.view);if(n.dataset.view===state.view)n.setAttribute('aria-current','page');else n.removeAttribute('aria-current');});
  $$('[data-mode]').forEach(n=>{n.classList.toggle('active',n.dataset.mode===state.mode);n.setAttribute('aria-pressed',String(n.dataset.mode===state.mode));});
  let html='';
  if(state.view==='overview'){
    const cats=v.categories.map(r=>({Name:r.Category,incidents:r.Incidents})).sort((a,b)=>b.incidents-a.incidents),leaders=groupRows(rows,'RHO');
    html=kpis()+`<div class="chart-grid"><section class="panel chart-panel">${header(state.mode==='buy'?'Daily buying price vs benchmark':'Daily sale price vs benchmark','SOURCE DAILY COMPARISON','<span class="pill">BDT / unit</span>')}${trendChart()}<div class="chart-meta"><span><i class="actual"></i>${state.mode==='buy'?'Unit receiving cost':'Incident sale price'}</span><span><i class="benchmark"></i>Source benchmark</span><span><i class="quantity"></i>Relative quantity</span></div><p class="chart-hint">Source chart measures. Click a point or quantity column for details.</p></section><section class="panel chart-panel">${header('Where incidents concentrate','SOURCE CATEGORY CONTRIBUTION','<span class="pill">Incidents</span>')}${ranks(cats,'incidents',null,'Category')}<p class="chart-hint">Counts use the source category incident measure.</p></section></div>`+scopeNote()+`<div class="chart-grid"><section class="panel chart-panel">${header('RHO review priorities','INDICATIVE BENCHMARK GAP','<span class="pill">BDT</span>')}${ranks(leaders,'benchmarkGap','RHO')}<p class="chart-hint">Current owner mapping · Click a leader to inspect their exceptions.</p></section><section class="panel chart-panel">${header('Most exposed subcategories','ELIGIBLE DETAIL ROWS','<span class="pill">BDT</span>')}${ranks(groupRows(rows,'Subcategory'),'benchmarkGap',null,'Subcategory')}<p class="chart-hint">Quantity × positive source unit difference. No risk score is invented.</p></section></div>`+table('priority','Outlet review priorities','ORDERED BY INDICATIVE BENCHMARK GAP',outletColumns,all.slice(0,10),'outlet',10);
  }
  if(state.view==='leaders')html=scopeNote()+table('rho','RHO-wise summary','CURRENT OWNER · ELIGIBLE DETAIL ROWS',leaderColumns('RHO'),groupDetail(rows,'RHO'),'leader')+table('zonal','Zonal-wise summary','CURRENT OWNER · ELIGIBLE DETAIL ROWS',leaderColumns('Zonal'),groupDetail(rows,'Zonal'),'leader');
  if(state.view==='outlets')html=kpis()+table('outlets','Outlet-wise summary','OWNER, EXPOSURE AND EXCEPTION COVERAGE',outletColumns,all)+table('detail','Source exception detail',state.mode==='buy'?'DAY · OUTLET · ARTICLE':'OUTLET · ARTICLE · SELECTED PERIOD',detailColumns(),rows,'detail');
  if(state.view==='articles')html=table('articles','Article-wise summary','ARTICLES DRIVING THE BENCHMARK GAP',articleColumns,groupDetail(rows,'ArticleCode'),'article')+table('articleDetail','Source article exceptions','PRICE AND BENCHMARK FROM POWER BI',detailColumns(),rows,'detail');
  if(state.view==='supplemental'){html=`<div class="notice">${state.mode==='buy'?'DC source rows use DK11 / DK14 and positive receiving quantity. They retain the original DC benchmark and are not added to the outlet headline.':'The original Power BI daily table selects deviation below −20%. These daily records are separate from the periodic Outlet–Article incident headline.'}</div>`+table('supplemental',state.mode==='buy'?'DC source comparison':'Daily under-sale source detail','ORIGINAL SOURCE TABLE CONTEXT',detailColumns(true),v.supplemental,'detail',null,state,'supplemental');}
  if(state.view==='source')html=renderSource();
  $('#dashboardContent').innerHTML=html;$('#footerSource').innerHTML=`${numberLink(number(v.detail.length),metricScenario(numberContext(),{metric:'records',value:v.detail.length,label:'Eligible detail rows'}))} eligible detail rows · ${numberLink(number(state.snapshot.organization.rows.length),mappingScenario(numberContext()))} outlet mappings · ${state.mode==='buy'?'Over buying':'Under sale'}`;counter();
}
function rerenderTable(id,focusSearch=false){const node=$(`[data-table="${id}"]`),entry=state.tables.get(id);if(!node||!entry)return;const input=node.querySelector('.table-search'),cursor=input.selectionStart;render();if(focusSearch){const newInput=$(`[data-table="${id}"] .table-search`);newInput.focus();newInput.setSelectionRange(cursor,cursor);}}
function openDrawer(key,value,context=numberContext(),dataset='detail',nested=false){
  const s=dataset==='organization'?mappingScenario(context,value):groupScenario(context,key,value,{label:'Source exception detail',metric:'records'});
  if(dataset!=='organization'){s.dataset=dataset;s.rows=(context.view[dataset]||[]).filter(r=>String(r[key]||'Not mapped')===value);s.value=s.rows.length;}
  showNumberDetail(s,nested);
}
function showNumberDetail(scenario,nested=false){
  const wasOpen=!$('#detailDrawer').hidden;
  if(!wasOpen)state.focusReturn=document.activeElement;
  if(nested&&wasOpen&&drawerState.scenario)drawerState.history.push(drawerState.scenario);
  else if(!nested)drawerState.history=[];
  drawerState.scenario=scenario;drawerState.tableStates.clear();renderNumberDetail();
  $('#detailDrawer').hidden=false;$('#drawerBackdrop').hidden=false;$('#main').inert=true;$('.topbar').inert=true;$('#sidebar').inert=true;$('#closeDrawer').focus();
}
function renderNumberDetail(){
  const s=drawerState.scenario,c=s.context,t=scenarioTotals(s);drawerState.numberLinks.clear();drawerState.tables.clear();
  $('#drawerTitle').textContent=s.title;
  const mode=c.mode==='buy'?'Over buying price':'Under sale price';
  const filters=Object.entries(c.applied).filter(([key,value])=>Array.isArray(value)&&value.length).map(([key,value])=>({regions:'Division / Region',rhos:'RHO',zonals:'Zonal',outlets:'Outlets',articles:'Articles',categories:'Subcategories',masterCategories:'Master category',movements:'Movements',purchaseTypes:'Purchase type'}[key])+': '+value.join(', ')).join(' · ');
  const fact=(label,display,scenario)=>'<div class="drawer-fact"><span>'+esc(label)+'</span><strong>'+numberLink(display,scenario,drawerState)+'</strong></div>';
  let html=(drawerState.history.length?'<button class="button" data-detail-back>← Back to previous detail</button>':'')+
    '<p class="drawer-intro">'+esc(mode)+' · '+esc(date(c.view.scope.start)+' – '+date(c.view.scope.end))+'<br>'+esc(filters)+'<br>Power BI refreshed '+esc(timestamp(c.sourceTimestamp))+'</p>'+
    '<div class="drawer-facts">'+fact(s.label,s.display??numericCell(s.value),s)+
    fact(s.presentation==='organization'?'Ownership records':s.presentation==='trend'?'Daily source points':'Matching detail rows',number(t.records),metricScenario(c,{rows:s.rows,dataset:s.dataset,metric:'records',value:t.records,label:'Matching detail rows',presentation:s.presentation==='organization'?'organization':s.presentation==='trend'?'trend':'details',trend:s.presentation==='trend'?s.trend:null}))+
    (s.presentation==='organization'?fact('Outlet codes',number(t.outlets),s):fact('Benchmark gap · BDT',money(t.benchmarkGap),metricScenario(c,{rows:s.rows,dataset:s.dataset,metric:'benchmarkGap',value:t.benchmarkGap,label:'Indicative benchmark gap'})))+'</div>';
  if(s.note)html+='<p class="drawer-hint">'+esc(s.note)+'</p>';
  if(s.sourceMeasure){
    html+='<p class="drawer-hint">The clicked value is a Power BI source measure in the displayed scope. The exception records retain their original price and benchmark context.</p><dl class="rule-list">'+sourceMeasures(s).map(m=>'<div class="rule-row"><dt>'+esc(m.label)+'</dt><dd>'+numberLink(numericCell(m.value,m.type),(s.trend?trendScenario(c,s.trend,m.key):metricScenario(c,{metric:m.key,value:m.value,label:m.label,sourceMeasure:true,...(s.entity?{rows:s.rows,entity:s.entity}:{})})),drawerState)+'</dd></div>').join('')+'</dl>';
  }
  if(s.trend){
    const cols=[{key:'Date',label:'Date'},{key:'Day',label:'Day label'},{key:'Quantity',label:'Source quantity',numeric:true,type:'quantity'},{key:'UnitPrice',label:'Source unit price',numeric:true,type:'quantity'},{key:'Benchmark',label:'Source benchmark',numeric:true,type:'quantity'}];
    html+=table('drillTrend','Selected daily source point','POWER BI CHART MEASURES',cols,[s.trend],'detail',null,drawerState,'trend',c);
  }
  if(s.presentation==='organization'){
    const cols=[{key:'OutletCode',label:'Outlet code',drill:'OutletCode'},{key:'OutletName',label:'Outlet name'},{key:'RHO',label:'RHO'},{key:'Zonal',label:'Zonal'},{key:'Division',label:'Division'},{key:'District',label:'District'},{key:'Area',label:'Area'}];
    html+=table('drillMapping','Published outlet ownership','ZONE DISTRIBUTION',cols,scenarioRows(s),'detail',null,drawerState,'organization',c);
  }else if(s.presentation!=='trend'){
    if(s.presentation==='outlets')html+=table('drillOutlets','Matching outlets','CONTRIBUTORS TO THE CLICKED FIGURE',[...outletColumns,{key:'Mapping',label:'Ownership mapping'}],scenarioRows(s),'outlet',null,drawerState,s.dataset,c);
    if(s.presentation==='articles')html+=table('drillArticles','Matching articles','CONTRIBUTORS TO THE CLICKED FIGURE',articleColumns,scenarioRows(s),'article',null,drawerState,s.dataset,c);
    const caption=s.dataset==='supplemental'?(c.mode==='buy'?'ORIGINAL DC COMPARISON':'ORIGINAL DAILY DETAIL BELOW −20%'):(c.mode==='buy'?'DAY · OUTLET · ARTICLE':'OUTLET · ARTICLE · SELECTED PERIOD');
    const cols=[...detailColumns(s.dataset==='supplemental'),{key:'Amount',label:'Source amount · BDT',numeric:true,type:'money'},{key:'COGS',label:'COGS · BDT',numeric:true,type:'money'},{key:'SaleMargin',label:'Source sale margin',numeric:true,type:'ratio'},{key:'AvgMargin',label:'Source average margin',numeric:true,type:'ratio'}];
    html+=table('drillRecords','Matching source records',caption,cols,s.rows,'detail',null,drawerState,s.dataset,c);
    html+='<button class="button primary" id="drawerCsv">'+icon('download')+'Export all matching exceptions</button>';
  }
  $('#drawerBody').innerHTML=html;
  $('#drawerCsv')?.addEventListener('click',()=>saveCsv(DETAIL_COLUMNS,s.rows,'SHWAPNO_'+c.mode+'_Detail_'+s.title.replace(/[^a-z0-9_-]/gi,'_')+'_'+c.view.scope.end));
}
function closeDrawer(){if($('#detailDrawer').hidden)return;$('#detailDrawer').hidden=true;$('#drawerBackdrop').hidden=true;drawerState.scenario=null;drawerState.history=[];$('#main').inert=false;$('.topbar').inert=false;$('#sidebar').inert=false;if(state.focusReturn?.isConnected)state.focusReturn.focus();else $('#main').focus();}
function theme(value){document.documentElement.dataset.theme=value;try{localStorage.setItem('shwapno-pricing-theme',value);}catch{}$('#themeToggle').innerHTML=icon(value==='dark'?'sun':'moon');$('#themeToggle').setAttribute('aria-label',`Switch to ${value==='dark'?'light':'dark'} mode`);}
function nav(open){$('#sidebar').classList.toggle('open',open);$('#navBackdrop').hidden=!open;$('#menuToggle').setAttribute('aria-expanded',String(open));}
function reEnrichSnapshot(snap,org){snap.organization=org;for(const m of Object.values(snap.modes)){for(const k of ['detail','supplemental','outlets'])m[k]=enrich(m[k],org);}return snap;}
async function readShared(){const response=await fetch('./snapshot.json?refresh='+Date.now(),{cache:'no-store',signal:AbortSignal.timeout(45000)});if(!response.ok)throw new Error('Shared snapshot request failed ('+response.status+').');return validateSnapshot(await response.json());}
function remember(){
  try{
    // Store the complete two-mode result with only the source-default article
    // choices. Full active-article dimensions are reloaded from the published
    // snapshot; this keeps the last-valid fallback below browser cache limits.
    const categories=new Set(Object.values(state.snapshot.modes).flatMap(m=>m.scope.masterCategories || []));
    const cached={...state.snapshot,dimensions:{...state.snapshot.dimensions,articles:state.snapshot.dimensions.articles.filter(a=>categories.has(a.MasterCategory))}};
    localStorage.setItem(cacheKey,JSON.stringify(cached));
  }catch{}
}
async function checkSnapshot(manual=false){
  if(state.busy||window.__PREVIEW__)return;setBusy(true);
  if(manual)status('Checking latest shared snapshot','Reading the latest validated source snapshot.','pending');
  try{
    const response=await fetch('./snapshot-status.json?refresh='+Date.now(),{cache:'no-store',signal:AbortSignal.timeout(30000)});const health=response.ok?await response.json():null;
    if(manual||!health||Date.parse(health.snapshotGeneratedAt || '')>Date.parse(state.snapshot.generatedAt)){
      const next=await readShared();
      if(canReplaceSnapshot(next,state.snapshot)){
        const wasDefault=isDefault(state.applied),pending=JSON.stringify(state.filters)!==JSON.stringify(state.applied),oldDefaults=defaults(),draft=structuredClone(state.filters);state.snapshot=next;state.client=null;
        if(wasDefault){state.applied=defaults();state.filters=pending?draft:defaults();if(pending&&draft.period==='source'&&draft.start===oldDefaults.start&&draft.end===oldDefaults.end){state.filters.start=defaults().start;state.filters.end=defaults().end;}state.current=state.snapshot.modes[state.mode];syncControls();render();}
        else {
          if(state.applied.period!=='custom'){
            const end=defaults().end,start=state.applied.period==='source'?defaults().start:new Date(Date.parse(end+'T00:00:00Z')-(Number(state.applied.period)-1)*86400000).toISOString().slice(0,10);
            state.applied.start=start;state.applied.end=end;
            if(!pending){state.filters=structuredClone(state.applied);}else if(draft.period!=='custom'){state.filters.start=start;state.filters.end=end;}
            syncControls();
          }
          const client=await new PricingClient().connect();state.client=client;state.current=await loadMode(client,state.mode,{...state.applied,outlets:territoryOutlets(state.applied)},next.organization,next.dimensions);render();
        }
        remember();notice('');
      }
    }
    statusCurrent();
    if(health?.result==='failed'){status('Last valid Power BI snapshot',`Latest background update failed · Source refreshed ${timestamp(state.snapshot.sourceTimestamp)}`,'failed');if(manual)notice('The latest background update failed. The last validated snapshot remains available. Check GitHub Actions for the failed run.');}
    else if(manual){$('#snapshotLabel').textContent='Shared snapshot checked';$('#snapshotTime').textContent=`Source refreshed ${timestamp(state.snapshot.sourceTimestamp)} · Checked ${timestamp(new Date().toISOString())}`;}
    // Mapping updates can arrive independently of the Power BI model refresh.
    if(!window.__PREVIEW__){try{
      const org=await loadOrganization();
      if(Date.parse(org.updatedAt)>Date.parse(state.snapshot.organization.updatedAt)){
        let updated;
        if(state.applied.rhos.length||state.applied.zonals.length){
          const codes=territoryOutlets(state.applied,org),client=await new PricingClient().connect();state.client=client;
          updated=await loadMode(client,state.mode,{...state.applied,outlets:codes.length?codes:['__NO_MATCHING_OUTLET__']},org,state.snapshot.dimensions);
        }else updated={...state.current,detail:enrich(state.current.detail,org),supplemental:enrich(state.current.supplemental,org),outlets:enrich(state.current.outlets,org)};
        reEnrichSnapshot(state.snapshot,org);state.current=updated;updateFilterLabels();render();remember();
      }
    }catch{}}
  }catch(error){status('Last valid Power BI snapshot',`Unable to check updates · Source refreshed ${timestamp(state.snapshot.sourceTimestamp)}`,'failed');if(manual)notice(error.message+' The last valid snapshot has been retained.');}
  finally{setBusy(false);}
}
async function boot(){
  icons();$('#powerbiSide').href=SETTINGS.reportUrl;$('#zoneSide').href=SETTINGS.zoneDashboardUrl;initFilters();
  try{theme(localStorage.getItem('shwapno-pricing-theme')==='light'?'light':'dark');}catch{theme('dark');}
  try{
    let cached=null;try{const raw=localStorage.getItem(cacheKey);if(raw)cached=validateSnapshot(JSON.parse(raw));}catch{}
    let fresh;
    try{fresh=window.__INITIAL_SNAPSHOT__?validateSnapshot(window.__INITIAL_SNAPSHOT__):await readShared();}catch(error){if(!cached)throw error;fresh=cached;notice('The latest snapshot could not be reached. Showing the last validated copy.');}
    state.snapshot=cached&&cached.sourceReport===SETTINGS.reportUrl&&fresh.generatedAt!==cached.generatedAt&&!canReplaceSnapshot(fresh,cached)?cached:fresh;
    state.filters=defaults();state.applied=structuredClone(state.filters);state.current=state.snapshot.modes[state.mode];syncControls();render();statusCurrent();remember();
    if(!window.__PREVIEW__){checkSnapshot();setInterval(()=>{if(!document.hidden)checkSnapshot();},SETTINGS.snapshotCheckMs);document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkSnapshot();});}
  }catch(error){$('#dashboardContent').innerHTML=`<section class="panel rules-panel"><h2>Snapshot unavailable</h2><p>${esc(error.message)}</p><p>Run “Refresh snapshot and publish dashboard” in the new repository’s Actions tab, then refresh this page.</p></section>`;status('Snapshot unavailable','A complete validated snapshot is required.','failed');$('#excelButton').disabled=true;}
}
$('#navigation').addEventListener('click',event=>{const button=event.target.closest('[data-view]');if(!button||!state.current)return;state.view=button.dataset.view;closePopovers();nav(false);render();});
$$('[data-mode]').forEach(button=>button.addEventListener('click',()=>{if(state.busy||!state.snapshot||state.mode===button.dataset.mode)return;state.mode=button.dataset.mode;state.filters=defaults();state.applied=structuredClone(state.filters);state.current=state.snapshot.modes[state.mode];state.tableStates.clear();syncControls();notice('');render();statusCurrent();}));
$('#period').addEventListener('change',()=>{const value=$('#period').value;state.filters.period=value;if(value==='source'){state.filters.start=defaults().start;state.filters.end=defaults().end;}else if(value!=='custom'){state.filters.end=defaults().end;state.filters.start=new Date(Date.parse(defaults().end+'T00:00:00Z')-(Number(value)-1)*86400000).toISOString().slice(0,10);}syncControls();});
for(const id of ['dateFrom','dateTo'])$('#'+id).addEventListener('change',()=>{state.filters.period='custom';$('#period').value='custom';readControls();});
for(const id of ['deviationFloor','qtyFloor'])$('#'+id).addEventListener('change',readControls);
$('#advancedButton').addEventListener('click',()=>{const box=$('#advancedFilters');box.hidden=!box.hidden;$('#advancedButton').setAttribute('aria-expanded',String(!box.hidden));});
$('#applyButton').addEventListener('click',applyScope);$('#quickApply').addEventListener('click',applyScope);
$('#resetButton').addEventListener('click',()=>{if(!state.snapshot||state.busy)return;state.filters=defaults();syncControls();applyScope();});
$('#refreshButton').addEventListener('click',()=>{if(state.snapshot)checkSnapshot(true);else location.reload();});
$('#themeToggle').addEventListener('click',()=>theme(document.documentElement.dataset.theme==='dark'?'light':'dark'));
$('#menuToggle').addEventListener('click',()=>nav(!$('#sidebar').classList.contains('open')));$('#navBackdrop').addEventListener('click',()=>nav(false));
$('#excelButton').addEventListener('click',async()=>{if(!state.current)return;$('#excelButton').disabled=true;try{await exportManagement(state.current,state.mode,state.snapshot);}catch(e){notice('Excel export failed: '+e.message);}finally{$('#excelButton').disabled=false;}});
let searchTimer;
$('#dashboardContent').addEventListener('input',event=>{if(!event.target.classList.contains('table-search'))return;const id=event.target.closest('[data-table]').dataset.table;state.tableStates.get(id).search=event.target.value;state.tableStates.get(id).page=1;clearTimeout(searchTimer);searchTimer=setTimeout(()=>rerenderTable(id,true),180);});
$('#main').addEventListener('click',event=>{
  const link=event.target.closest('[data-number-link]');if(link){const scenario=state.numberLinks.get(link.dataset.numberLink);if(scenario)showNumberDetail(scenario);return;}
  const drill=event.target.closest('[data-drill]');if(drill){const entry=state.tables.get(drill.closest('[data-table]')?.dataset.table);openDrawer(drill.dataset.drillKey,drill.dataset.drill,entry?.context || numberContext(),entry?.dataset || 'detail');return;}
  const tableNode=event.target.closest('[data-table]');if(!tableNode)return;const id=tableNode.dataset.table,t=state.tableStates.get(id),sort=event.target.closest('[data-sort]'),page=event.target.closest('[data-page]'),csv=event.target.closest('[data-csv]');
  if(sort){t.dir=t.sort===sort.dataset.sort?-t.dir:(state.tables.get(id).columns.find(c=>c.key===sort.dataset.sort)?.numeric?-1:1);t.sort=sort.dataset.sort;t.page=1;rerenderTable(id);}
  if(page){t.page+=Number(page.dataset.page);rerenderTable(id);}
  if(csv){const entry=state.tables.get(id);saveCsv(entry.columns.map(c=>[c.key,c.label]),entry.rows,'SHWAPNO_'+entry.title.replace(/[^a-z0-9_-]/gi,'_')+'_'+state.current.scope.end);}
});
$('#closeDrawer').addEventListener('click',closeDrawer);$('#drawerBackdrop').addEventListener('click',closeDrawer);
document.addEventListener('keydown',event=>{if(event.key==='Escape'){closeDrawer();closePopovers();nav(false);}if(event.key==='Tab'&&!$('#detailDrawer').hidden){const focusable=[...$('#detailDrawer').querySelectorAll('button,a,input,[tabindex="0"]')];const first=focusable[0],last=focusable.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}});

function sourceTextLinks(text){
  const c=numberContext();let result='',at=0;
  for(const match of String(text).matchAll(/[-+]?\d[\d,]*(?:\.\d+)?%?/g)){
    result+=esc(text.slice(at,match.index));
    const value=Number(match[0].replaceAll(',','').replace('%',''));
    result+=numberLink(match[0],metricScenario(c,{metric:'SourceText',label:'Power BI summary value',value,sourceMeasure:true,note:String(text)}));
    at=match.index+match[0].length;
  }
  return result+esc(text.slice(at));
}
function svgNumberLink(row,key){
  const scenario=trendScenario(numberContext(),row,key),id='main-'+state.numberLinks.size;
  state.numberLinks.set(id,{...scenario,display:number(row[key],2)});
  return 'data-number-link="'+id+'" role="button" tabindex="0" aria-haspopup="dialog" aria-controls="detailDrawer" aria-label="View '+esc(scenario.label)+' for '+esc(scenario.entity)+'"';
}
function tableAction(event,target,rerender){
  const tableNode=event.target.closest('[data-table]');if(!tableNode)return;
  const id=tableNode.dataset.table,t=target.tableStates.get(id),entry=target.tables.get(id);if(!t||!entry)return;
  const sort=event.target.closest('[data-sort]'),page=event.target.closest('[data-page]'),csv=event.target.closest('[data-csv]');
  if(sort){t.dir=t.sort===sort.dataset.sort?-t.dir:(entry.columns.find(col=>col.key===sort.dataset.sort)?.numeric?-1:1);t.sort=sort.dataset.sort;t.page=1;rerender();}
  if(page){t.page+=Number(page.dataset.page);rerender();}
  if(csv)saveCsv(entry.columns.map(col=>[col.key,col.label]),entry.rows,'SHWAPNO_'+entry.context.mode+'_'+entry.title.replace(/[^a-z0-9_-]/gi,'_')+'_'+entry.context.view.scope.end);
}
$('#drawerBody').addEventListener('click',event=>{
  if(event.target.closest('[data-detail-back]')){drawerState.scenario=drawerState.history.pop();drawerState.tableStates.clear();renderNumberDetail();$('#closeDrawer').focus();return;}
  const link=event.target.closest('[data-number-link]');if(link){const scenario=drawerState.numberLinks.get(link.dataset.numberLink);if(scenario)showNumberDetail(scenario,true);return;}
  const drill=event.target.closest('[data-drill]');if(drill){const entry=drawerState.tables.get(drill.closest('[data-table]')?.dataset.table);openDrawer(drill.dataset.drillKey,drill.dataset.drill,entry?.context || drawerState.scenario.context,entry?.dataset || drawerState.scenario.dataset,true);return;}
  tableAction(event,drawerState,renderNumberDetail);
});
let drawerSearchTimer;
$('#drawerBody').addEventListener('input',event=>{
  if(!event.target.classList.contains('table-search'))return;
  const id=event.target.closest('[data-table]').dataset.table,t=drawerState.tableStates.get(id),cursor=event.target.selectionStart;
  t.search=event.target.value;t.page=1;clearTimeout(drawerSearchTimer);
  drawerSearchTimer=setTimeout(()=>{if($('#detailDrawer').hidden)return;renderNumberDetail();const input=$('#drawerBody [data-table="'+id+'"] .table-search');input?.focus();input?.setSelectionRange(cursor,cursor);},180);
});
document.addEventListener('keydown',event=>{
  const node=event.target.closest?.('[data-number-link]');
  if(node&&node.tagName.toLowerCase()!=='button'&&['Enter',' '].includes(event.key)){event.preventDefault();const scenario=state.numberLinks.get(node.dataset.numberLink);if(scenario)showNumberDetail(scenario);}
});

boot();
