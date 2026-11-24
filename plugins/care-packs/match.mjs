import { diagnosisStatus } from "../../shared/diagnoses.mjs";

// Which care packs fit a patient, from the confirmed diagnoses on the chart.
// Only a suggestion: the doctor still decides and confirms enrollment.
const norm = (value) => String(value || "").replace(/\s+/g, "").toUpperCase();

export function diagnosisMatchesPack(match, diagnosis) {
  if (!match || diagnosisStatus(diagnosis) !== "confirmed") return false;
  const name = norm(typeof diagnosis === "string" ? diagnosis : diagnosis?.name);
  const code = norm(typeof diagnosis === "string" ? "" : diagnosis?.code);
  if ((match.exclude || []).some((word) => name.includes(norm(word)))) return false;
  if (code && (match.codes || []).some((prefix) => code.startsWith(norm(prefix)))) return true;
  return Boolean(name) && (match.keywords || []).some((word) => name.includes(norm(word)));
}

// Follow-up jobs created from a pack are named "<plan name> · <node title>".
// A pack is suggested when a diagnosis matches and the patient has no open
// job from it; when every job from an earlier enrollment has fired, the
// suggestion becomes a renewal.
export function suggestPacks(packs, diagnoses, followups) {
  const out = [];
  for (const pack of packs || []) {
    const diagnosis = (diagnoses || []).find((item) => diagnosisMatchesPack(pack.match, item));
    if (!diagnosis) continue;
    const prefix = `${pack.planName} · `;
    const jobs = (followups || []).filter((job) => String(job.name || "").startsWith(prefix));
    if (jobs.some((job) => job.status !== "completed")) continue;
    out.push({ pack, diagnosis: typeof diagnosis === "string" ? diagnosis : diagnosis.name, renewal: jobs.length > 0 });
  }
  return out;
}
