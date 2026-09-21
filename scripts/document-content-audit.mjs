// Semantic label/value audit of parsed PDF text. Creation/readback provenance
// is checked by the caller; this helper never substitutes another artifact.
export function quantityContentValid(parsed) {
  if (parsed?.truncated !== false || !Array.isArray(parsed.pages)) return false;
  const text = parsed.pages.map((p) => p.text || "").join("\n");
  if (!/\bSource(?: file)?\s*[:=]\s*sales\.csv(?![\w.])/i.test(text)) return false;
  return [["Alpha", 4], ["Beta", 6], ["Total", 10]].every(([label, expected]) => {
    const matches = [...text.matchAll(new RegExp(`\\b${label}\\b${label === "Total" ? "(?: quantity)?" : ""}\\s*(?:[=:]\\s*)?([+-]?\\d+(?:\\.\\d+)?)(?![\\w.]|,\\d)`, "g"))];
    return matches.length > 0 && matches.every((m) => Number(m[1]) === expected);
  });
}
