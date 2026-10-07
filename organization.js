import { SETTINGS } from './settings.js';
export const normalizeCode = value => String(value ?? '').trim().toUpperCase();
const text = value => String(value ?? '').trim();
export function normalizeOrganization(record) {
  const snapshot = record?.payload?.snapshot || record;
  if (!Array.isArray(snapshot?.rows) || !snapshot.rows.length) throw new Error('The Zone Distribution mapping is empty.');
  const byCode = new Map();
  const conflicts = new Set();
  for (const raw of snapshot.rows) {
    const row = {
      OutletCode: normalizeCode(raw.CODE ?? raw.code ?? raw.OutletCode),
      OutletName: text(raw['Outlet Name'] ?? raw.name ?? raw.OutletName),
      Division: text(raw.Division ?? raw.division), District: text(raw.District ?? raw.district), Area: text(raw.Area ?? raw.area),
      RHO: text(raw['Regional Head HR Name'] ?? raw.RHO ?? raw.leader ?? raw.Leader),
      Zonal: text(raw['Zonal HR Name'] ?? raw.zonal ?? raw.Zonal),
      Format: text(raw.Format ?? raw.format), Status: text(raw.Status ?? raw.status),
    };
    if (!row.OutletCode) continue;
    const previous = byCode.get(row.OutletCode);
    if (previous && ['RHO','Zonal','Division'].some(k => previous[k] && row[k] && previous[k] !== row[k])) conflicts.add(row.OutletCode);
    if (!previous) byCode.set(row.OutletCode,row);
  }
  for (const code of conflicts) {
    const row = byCode.get(code); row.RHO = 'Mapping conflict'; row.Zonal = 'Mapping conflict';
  }
  if(!byCode.size)throw new Error('Zone Distribution contains no usable outlet codes. The previous mapping is retained.');
  return {rows:[...byCode.values()],sourceFile:snapshot.fileName || 'Zone Distribution',updatedAt:snapshot.savedAt || record.updated_at || null,conflicts:[...conflicts]};
}
export async function loadOrganization() {
  const response = await fetch(SETTINGS.zoneSnapshotUrl,{headers:{apikey:SETTINGS.zonePublishableKey},cache:'no-store',signal:AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error(`Zone Distribution mapping failed (${response.status}).`);
  const result = await response.json();
  return normalizeOrganization(result?.[0]);
}
export function enrich(rows, organization) {
  const byCode = new Map((organization?.rows || []).map(r => [normalizeCode(r.OutletCode),r]));
  return rows.map(raw => {
    const sourceCode=normalizeCode(Object.hasOwn(raw,'SourceOutletCode')?raw.SourceOutletCode:raw.OutletCode);
    const row = {...raw,SourceOutletCode:sourceCode || null,OutletCode:sourceCode || 'Not supplied'};
    const org = byCode.get(row.OutletCode);
    return {...row,OutletName:row.OutletName || org?.OutletName || row.OutletCode,
      Division:org?.Division || row.Region || 'Not mapped',District:org?.District || 'Not mapped',Area:org?.Area || 'Not mapped',
      RHO:org?.RHO || 'Not mapped',Zonal:org?.Zonal || 'Not mapped',Mapping:org ? (organization.conflicts?.includes(row.OutletCode) ? 'Conflict' : 'Mapped') : 'Not mapped'};
  });
}
