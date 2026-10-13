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
    // 绘图不再要求「≥2 个不同日期且同日唯一」：散点画出全部有效记录（同日多值并列），
    // 是否连线（趋势）由 LabPlot 判断——只有 ≥2 个日期且无同日冲突才连。
    const points = dated.toSorted((a,b) => a.date===b.date ? a.value-b.value : String(a.date).localeCompare(String(b.date)));
    return { ...group, records, points, conflict, distinctDates: dates.size, canPlot: points.length > 0 };
  });
}

// Notes contain arbitrary provenance/identity checks and are never a clinical summary.
export function dashboardHistory(patient) {
  return [...(patient.visits || [])].sort((a,b)=>String(a.date || "9999").localeCompare(String(b.date || "9999")));
}
