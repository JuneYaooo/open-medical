// Chat tools for return visits and unread lab results. Both are the
// doctor's own bookkeeping (nothing reaches the patient), so they run
// directly, like care_reply_draft.
const definition = (name, description, properties = {}, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
});
const text = { type: "string" };

export function scheduleTools(getSchedule) {
  const schedule = () => {
    const service = getSchedule();
    if (!service) throw new Error("复诊预约模块未启用");
    return service;
  };
  return [
    {
      definition: definition("appointment_list", "列出某患者的复诊预约（日期、时间、事项、状态：scheduled 已预约 / attended 已到诊 / missed 未到诊 / cancelled 已取消）。", { patientId: text }, ["patientId"]),
      execute: ({ patientId }) => schedule().appointments(patientId),
    },
    {
      definition: definition("appointment_create", "为患者登记一次复诊预约。医生明确说出日期时调用；到期前一天和当天会出现在今日待办。不会通知患者。", {
        patientId: text, date: { type: "string", description: "YYYY-MM-DD，不早于今天" }, time: { type: "string", description: "HH:MM，可省略" }, reason: text, place: text,
      }, ["patientId", "date"]),
      execute: ({ patientId, ...input }) => schedule().create(patientId, input),
    },
    {
      definition: definition("appointment_update", "改期或登记复诊结果：status=attended 已到诊、missed 未到诊、cancelled 取消；改期时传新的 date/time。", {
        appointmentId: text, status: { type: "string", enum: ["scheduled", "attended", "missed", "cancelled"] }, date: text, time: text, reason: text, note: text,
      }, ["appointmentId"]),
      execute: ({ appointmentId, ...input }) => schedule().update(appointmentId, input),
    },
    {
      definition: definition("patient_new_labs", "读取某患者尚未被医生标记已阅的新检验结果。医生在对话中说已看过时，可设置 markReviewed=true 全部标记已阅。", { patientId: text, markReviewed: { type: "boolean" } }, ["patientId"]),
      execute: ({ patientId, markReviewed }) => markReviewed ? schedule().markLabsReviewed(patientId) : { labs: schedule().newLabs(patientId) },
    },
  ];
}
