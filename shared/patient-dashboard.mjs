// Only compare observations with exactly matching item names and units.
export function dashboardLabGroups(labs = []) {
  const groups = new Map();
  for (const lab of labs) {
    const key = JSON.stringify([lab.item, lab.unit || '']);
    if (!groups.has(key)) groups.set(key, { key, item: lab.item, unit: lab.unit || '', records: [] });
    groups.get(key).records.push(lab);
  }
  return [...groups.values()].map(group => {
    const records = group.records.toSorted((a,b) => String(a.date || '').localeCompare(String(b.date || '')));
    const dated = records.filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') && Number.isFinite(Date.parse(r.date)) && new Date(r.date).toISOString().slice(0,10) === r.date && Number.isFinite(r.value));
    const dates = new Map();
    for(const r of dated) { if(!dates.has(r.date)) dates.set(r.date,new Set()); dates.get(r.date).add(r.value); }
    const conflict = [...dates.values()].some(values => values.size > 1);
    const points = [...new Map(dated.map(r => [r.date,r])).values()];
    return { ...group, records, points, conflict, canPlot: !!group.unit && !conflict && points.length > 1 };
  });
}

// Notes contain arbitrary provenance/identity checks and are never a clinical summary.
export function dashboardHistory(patient) {
  return [...(patient.visits || [])].sort((a,b)=>String(a.date || "9999").localeCompare(String(b.date || "9999")));
}
