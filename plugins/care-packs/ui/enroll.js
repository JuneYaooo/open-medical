import { api } from "../../../src/agent-runtime";

// The doctor has seen the pack and clicked enroll, so the proposal is
// confirmed right away; it still leaves an audit record.
export async function enrollInPack(packId, patientId, startDate) {
  const { proposal } = await api(`/api/p/care-packs/packs/${packId}/apply`, "POST", { patientId, startDate });
  try {
    const { applied } = await api(`/api/pending-actions/${proposal.id}/confirm`, "POST", {});
    return applied;
  } catch (error) {
    // Do not leave an orphan proposal in the tray; each retry would add another.
    await api(`/api/pending-actions/${proposal.id}/reject`, "POST", { note: "入组确认失败，已自动撤回" }).catch(() => {});
    throw error;
  }
}

export const monitorNote = (applied) =>
  applied.monitorsUnavailable ? "（风险规则插件未启用，未加检验监测）" : applied.monitorsSkipped ? `（${applied.monitorsSkipped} 项监测已存在）` : "";
