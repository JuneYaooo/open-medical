export function patientIdentityLabel(patient) {
  return [patient.patientNumber || patient.id?.slice(0, 8), patient.birthYear ? `${patient.birthYear} 年生` : null,
    patient.phone ? `尾号 ${patient.phone.slice(-4)}` : null].filter(Boolean).join(" · ");
}
export function patientOptionLabel(patient, patients = []) {
  return patients.some((other) => other.id !== patient.id && other.name === patient.name)
    ? `${patient.name} · ${patientIdentityLabel(patient)}` : patient.name;
}
