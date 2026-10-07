export function validateSnapshot(value) {
  if (value?.version !== 1 || !value.generatedAt || !value.sourceReport || !value.organization?.rows?.length) throw new Error('The shared snapshot is incomplete.');
  for (const mode of ['buy','sale']) {
    const view=value.modes?.[mode];
    if (!view?.scope?.start || !view.scope.end || !Array.isArray(view.detail) || !Array.isArray(view.trend) || !Number.isFinite(view.summary?.Incidents)) throw new Error(`The ${mode} snapshot is incomplete.`);
    if (view.scope.start>view.scope.end || !Number.isFinite(Date.parse(value.generatedAt))) throw new Error('The shared snapshot has an invalid date range.');
    for (const row of [...view.detail,...(view.supplemental || [])]) {
      if (!row.OutletCode || !row.ArticleCode || (row.Quantity != null && !Number.isFinite(row.Quantity)) || (row.UnitPrice != null && !Number.isFinite(row.UnitPrice)) || (row.Benchmark != null && !Number.isFinite(row.Benchmark))) throw new Error('Power BI returned an invalid detail value.');
    }
  }
  return value;
}
export function canReplaceSnapshot(candidate,current) {
  validateSnapshot(candidate);
  if (!current) return true;
  if (candidate.sourceReport !== current.sourceReport) return true;
  if (Date.parse(candidate.generatedAt) <= Date.parse(current.generatedAt)) return false;
  if (candidate.sourceTimestamp && current.sourceTimestamp && Date.parse(candidate.sourceTimestamp)<Date.parse(current.sourceTimestamp)) return false;
  return ['buy','sale'].every(mode=>candidate.modes[mode].scope.end>=current.modes[mode].scope.end);
}
