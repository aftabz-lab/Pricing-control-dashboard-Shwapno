import { SETTINGS } from './settings.js';

const copy = value => JSON.parse(JSON.stringify(value));
export const column = (entity, property, name = property) => ({ Column: { Expression: { SourceRef: { Entity: entity } }, Property: property }, Name: name });
export const measure = (entity, property, name = property) => ({ Measure: { Expression: { SourceRef: { Entity: entity } }, Property: property }, Name: name });
export const sum = (entity, property, name = property) => ({ Aggregation: { Expression: column(entity, property), Function: 0 }, Name: name });
export const literal = value => ({ Literal: { Value: value } });
const textLiteral = value => literal(value == null ? 'null' : `'${String(value).replaceAll("'", "''")}'`);
export const includes = (entity, property, values) => ({ Condition: { In: { Expressions: [column(entity, property)], Values: values.map(v => [textLiteral(v)]) } } });
export const compare = (expression, kind, value) => ({ Condition: { Comparison: { ComparisonKind: kind, Left: expression, Right: literal(value) } } });
export const shiftDate = (value, days) => new Date(Date.parse(value + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
export function resourceKey(url) {
  const token = new URL(url).searchParams.get('r');
  const json = typeof atob === 'function' ? atob(token) : Buffer.from(token, 'base64').toString();
  const key = JSON.parse(json).k;
  if (!/^[a-f0-9-]{36}$/i.test(key || '')) throw new Error('The Power BI report URL has an invalid resource key.');
  return key;
}
function headers(key, post = false) {
  return { Accept: 'application/json', ActivityId: crypto.randomUUID(), RequestId: crypto.randomUUID(), 'X-PowerBI-ResourceKey': key, ...(post ? {'Content-Type': 'application/json'} : {}) };
}
async function readJson(url, options = {}) {
  const response = await fetch(url, {...options, cache: 'no-store', signal: options.signal || AbortSignal.timeout(180000)});
  if (!response.ok) throw new Error(`Power BI request failed (${response.status}).`);
  const raw = await response.text();
  try { return JSON.parse(raw); } catch { throw new Error('Power BI returned an incomplete JSON response. The previous snapshot is retained.'); }
}
function mask(value, index) { return Math.floor(Number(value || 0) / 2 ** index) % 2 === 1; }
export function decodeResult(entry) {
  if (entry?.result?.error) throw new Error(JSON.stringify(entry.result.error));
  const data = entry?.result?.data;
  if (!data) throw new Error('Power BI returned no query data.');
  for (const shape of data.dsr?.DataShapes || []) {
    const error = shape['odata.error'] || shape.error;
    if (error) throw new Error(error.message?.value || error.message || error.code || 'Power BI query failed.');
  }
  const descriptors = data.descriptor?.Select || [];
  const set = data.dsr?.DS?.[0];
  if (!set) return [];
  const encoded = (set.PH || []).flatMap(p => Object.entries(p).filter(([k,v]) => /^DM\d+$/.test(k) && Array.isArray(v)).flatMap(([,v]) => v));
  let schema = descriptors.map(d => ({ N: d.Value }));
  let previous = {};
  return encoded.map(row => {
    if (row.S) schema = row.S;
    let cursor = 0;
    const values = {};
    schema.forEach((field,i) => {
      let v = Object.hasOwn(row,field.N) ? row[field.N] : mask(row.R,i) ? previous[field.N] : mask(row['Ø'],i) ? null : (row.C || [])[cursor++];
      const dict = set.ValueDicts?.[field.DN];
      if (dict && Number.isInteger(v) && v >= 0 && v < dict.length) v = dict[v];
      values[field.N]=v;
    });
    previous = values;
    return Object.fromEntries(descriptors.map(d => {
      let value=values[d.Value];
      if (d.Kind === 2 && value != null && Number.isFinite(Number(value))) value=Number(value);
      return [d.Name,value];
    }));
  });
}
function entityExpression(value, sourceEntities = {}) {
  if (Array.isArray(value)) return value.map(v => entityExpression(v,sourceEntities));
  if (!value || typeof value !== 'object') return value;
  if (value.SourceRef?.Source) return {...value, SourceRef: { Entity: sourceEntities[value.SourceRef.Source] }};
  return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, entityExpression(v,sourceEntities)]));
}
function fromFilter(filter) {
  return (filter?.Where || []).map(w => entityExpression(w, Object.fromEntries((filter.From || []).map(s => [s.Name,s.Entity]))));
}
function hasField(value, entity, property) {
  if (!value || typeof value !== 'object') return false;
  if (value.Column?.Expression?.SourceRef?.Entity === entity && value.Column.Property === property) return true;
  return Object.values(value).some(v => hasField(v,entity,property));
}
function compile(select, where, count, order = []) {
  const entities = new Map();
  function walk(v) {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    if (v.SourceRef?.Entity) {
      const entity = v.SourceRef.Entity;
      if (!entities.has(entity)) entities.set(entity, 'e' + entities.size);
      return {...v, SourceRef: { Source: entities.get(entity) }};
    }
    return Object.fromEntries(Object.entries(v).map(([k,x]) => [k,walk(x)]));
  }
  const s = walk(select), w = walk(where), sort = walk(order);
  return {
    Query: { Commands: [{ SemanticQueryDataShapeCommand: {
      Query: { Version: 2, From: [...entities].map(([Entity,Name]) => ({Name,Entity,Type:0})), Select:s, ...(w.length ? {Where:w} : {}), ...(sort.length ? {OrderBy:sort} : {}) },
      Binding: { DataReduction: {DataVolume:6,Primary:{Window:{Count:count}}}, Primary:{Groupings:[{Projections:s.map((_,i)=>i)}]},Version:1 },
      ExecutionMetricsKind:1,
    }}] }, QueryId:'',
  };
}

export class PricingClient {
  constructor(settings = SETTINGS) {
    this.settings = {...settings};
    if (typeof process !== 'undefined') {
      if (process.env.PBI_EMBED_URL) this.settings.reportUrl = process.env.PBI_EMBED_URL;
      if (process.env.PBI_API_ROOT) this.settings.apiRoot = process.env.PBI_API_ROOT.replace(/\/+$/, '');
    }
    this.key = resourceKey(this.settings.reportUrl);
  }
  async connect() {
    const p = await readJson(`${this.settings.apiRoot}/public/reports/${this.key}/modelsAndExploration?preferReadOnlySession=true`,{headers:headers(this.key)});
    this.model = p.models?.[0]; this.report = p.exploration?.report;
    if (!this.model || !this.report) throw new Error('Power BI report metadata is missing.');
    const raw = p.exploration?.explorationContent?.explorationDocument || '{}';
    this.explorationDocument = raw;
    const doc = JSON.parse(raw);
    if (!doc.pages?.pages) throw new Error('The Power BI report definition has changed. Update the source adapter before publishing a snapshot.');
    this.pages = doc.pages.pages;
    this.sourceTimestamp = this.model.LastRefreshTime || p.package?.LastRefreshTime || null;
    if (this.sourceTimestamp && !/Z$|[+-]\d\d:\d\d$/.test(this.sourceTimestamp)) this.sourceTimestamp += 'Z';
    this.scopes = {};
    for (const [mode,name] of [['buy','Over Buying Price'],['sale','Under Sale Price']]) {
      const page = this.pages.find(p => p.content?.displayName === name);
      if (!page) throw new Error(`${name} source page is missing.`);
      const filters = [];
      for (const item of page.visualContainers || []) {
        const vis = item.content?.visual;
        if (!['slicer','listSlicer','textSlicer'].includes(vis?.visualType)) continue;
        for (const general of vis.objects?.general || []) filters.push(...fromFilter(general.properties?.filter?.filter));
      }
      const data = JSON.stringify(filters);
      const dates = [...data.matchAll(/datetime'(\d{4}-\d{2}-\d{2})/g)].map(m => m[1]).sort();
      if (dates.length < 2) throw new Error(`${name} saved date range cannot be read.`);
      this.scopes[mode] = {page,filters,start:dates[0],end:shiftDate(dates.at(-1),-1),deviationFloor:5,qtyFloor:2};
      const selections=filters.filter(f=>hasField(f,'DimArticle','MasterCategory')).map(f=>f.Condition?.In?.Values?.map(v=>String(v[0]?.Literal?.Value || '').replace(/^'|'$/g,'').replaceAll("''", "'"))).filter(Array.isArray);
      const allowed=selections.reduce((best,list)=>list.length>best.length?list:best,[]);
      const selected=selections.reduce((set,list)=>set===null?list:set.filter(v=>list.includes(v)),null);
      this.scopes[mode].masterCategories=selected || ['LOOSE COMMODITY'];
      this.scopes[mode].allowedMasterCategories=allowed.length>1?allowed:['COMPANY GOODS','FRESH PRODUCE','GENERAL MERCHANDISE','LIFESTYLE','LOOSE COMMODITY','PACKED COMMODITY'];
      for (const [key,ent] of [['deviationFloor','Deviation Floor'],['qtyFloor','Qty Floor']]) {
        const item = filters.find(f => hasField(f,ent,ent));
        const lit = item?.Condition?.Comparison?.Right?.Literal?.Value;
        if (lit && Number.isFinite(parseFloat(lit))) this.scopes[mode][key] = parseFloat(lit);
      }
    }
    return this;
  }
  visual(mode,id) { return this.scopes[mode].page.visualContainers.find(i => i.content?.name === id)?.content; }
  scopeWhere(mode, filters = {}) {
    const scope = this.scopes[mode];
    const where = scope.filters.filter(w => !hasField(w,'DimDate','Date') && !hasField(w,'DimArticle','MasterCategory') && !hasField(w,'Deviation Floor','Deviation Floor') && !hasField(w,'Qty Floor','Qty Floor'));
    const start = filters.start || scope.start, end = filters.end || scope.end;
    where.push(compare(column('DimDate','Date'),2,`datetime'${start}T00:00:00'`),compare(column('DimDate','Date'),3,`datetime'${shiftDate(end,1)}T00:00:00'`));
    const selectedCategories=filters.masterCategories ?? scope.masterCategories;
    const categories=selectedCategories.length?selectedCategories:scope.allowedMasterCategories;
    if (categories.length) where.push(includes('DimArticle','MasterCategory',categories));
    where.push(compare(column('Deviation Floor','Deviation Floor'),0,`${filters.deviationFloor ?? scope.deviationFloor}D`),compare(column('Qty Floor','Qty Floor'),0,`${filters.qtyFloor ?? scope.qtyFloor}D`));
    for (const [key,ent,prop] of [['categories','DimArticle','Cat 3'],['regions','DimOutlet','RegionName'],['outlets','DimOutlet','OutletCode'],['articles','DimArticle','ArticleNo'],['movements','Query3','movement_type'],['purchaseTypes','Query3','Purchase Type']]) {
      if (filters[key]?.length) where.push(includes(ent,prop,filters[key].map(v=>key==='outlets'&&v==='Not supplied'?null:v)));
    }
    return copy(where);
  }
  visualSpec(mode,id,key, filters = {}, extra = []) {
    const v = this.visual(mode,id);
    if (!v?.visual?.query?.queryState) throw new Error(`Source visual ${id} cannot be read.`);
    const query = v.visual.query;
    const projections = Object.values(query.queryState).flatMap(role => role.projections || []).filter(p => p.active !== false);
    const select = projections.map(p => ({...copy(p.field),Name:p.nativeQueryRef || p.queryRef}));
    const where = [...this.scopeWhere(mode,filters),...(v.filterConfig?.filters || []).flatMap(f => fromFilter(f.filter)),...extra];
    const order = (query.sortDefinition?.sort || []).map(s => ({Direction:s.direction === 'Descending' ? 2 : 1,Expression:s.field}));
    return {key,select,where,count:30000,order};
  }
  async run(specs, complete = true) {
    const output = {};
    // A small batch keeps public report queries predictable and avoids one
    // slow detail query holding every card response open.
    for (let offset=0;offset<specs.length;offset+=3) {
      const batch = specs.slice(offset,offset+3);
      let active = batch.map(spec => ({spec,query:compile(spec.select,spec.where || [],spec.count || 30000,spec.order || []), seen:new Set()}));
      batch.forEach(s => {output[s.key]=[];});
      let page = 0;
      while (active.length) {
        if (++page > 400) throw new Error('Power BI detail pagination exceeded the safe limit. The previous snapshot is retained.');
        const queries = active.map(a => ({...a.query,ApplicationContext:{DatasetId:this.model.dbName,Sources:[{ReportId:this.report.objectId}]}}));
        const payload = await readJson(`${this.settings.apiRoot}/public/reports/querydata?synchronous=true`,{method:'POST',headers:headers(this.key,true),body:JSON.stringify({version:'1.0.0',queries,cancelQueries:[],modelId:this.model.id})});
        if (!Array.isArray(payload.results) || payload.results.length !== active.length) throw new Error('Power BI returned an incomplete query batch.');
        const next=[];
        for (let i=0;i<active.length;i++) {
          const a=active[i], entry=payload.results[i];
          output[a.spec.key].push(...decodeResult(entry));
          const token=entry?.result?.data?.dsr?.DS?.[0]?.RT;
          if (token && complete) {
            const signature=JSON.stringify(token);
            if (a.seen.has(signature)) throw new Error('Power BI repeated a continuation token. No partial snapshot will be published.');
            a.seen.add(signature);
            a.query=copy(a.query);
            a.query.Query.Commands[0].SemanticQueryDataShapeCommand.Binding.DataReduction.Primary.Window.RestartTokens=token;
            next.push(a);
          } else if (token && !complete) output[a.spec.key+'_hasMore']=true;
        }
        active=next;
      }
    }
    return output;
  }
}
