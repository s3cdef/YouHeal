// Applies importer/supplements.json: records that do not come from the source PDFs (e.g. the clinic's
// application protocol cards). Runs after build() and before validation, so supplements are held to the
// same referential-integrity rules as PDF-derived records.
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function applySupplements(data, sup, report) {
  const add = (list, rec, what) => {
    if (list.some(r => r.id === rec.id)) throw new Error(`supplements: duplicate ${what} id "${rec.id}"`);
    list.push(rec);
    report.overridesApplied.push(`supplements.${what}: ${rec.id}`);
  };
  for (const s of sup.sources || []) add(data.sources, s, 'source');
  for (const p of sup.points || []) add(data.points, p, 'point');
  for (const [id, aliases] of Object.entries(sup.pointAliases || {})) {
    const p = data.points.find(x => x.id === id);
    if (!p) throw new Error(`supplements.pointAliases: unknown point "${id}"`);
    p.aliases = [...new Set([...(p.aliases || []), ...aliases])];
  }
  for (const p of sup.pairs || []) add(data.pairs, p, 'pair');
  for (const p of sup.protocols || []) add(data.protocols, p, 'protocol');

  data.points.sort(byId);
  const numbered = data.pairs.filter(p => p.level > 0).sort((a, b) => a.number - b.number);
  data.pairs = [...numbered, ...data.pairs.filter(p => p.level === 0).sort(byId)];
  return data;
}
