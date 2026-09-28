// HTTP surface of the care engine; mirrors the chat tools so the UI and
// the agent share the same deterministic services.
export async function careApi(care, req, url, { body, send }) {
  const p = url.pathname.split("/").filter(Boolean);
  if (p[0] !== "api" || p[1] !== "care") return false;
  const q = (key) => url.searchParams.get(key) || undefined;
  const reply = (value, status = 200) => { send(status, value); return true; };
  const get = req.method === "GET", post = req.method === "POST", put = req.method === "PUT";
  if (p.length === 3) {
    if (p[2] === "overview" && get) return reply(care.overview());
    if (p[2] === "inbox" && get) return reply(care.inbox({ status: q("status"), level: q("level"), patientId: q("patientId"), limit: q("limit") }));
    if (p[2] === "replies" && get) return reply(care.replies({ status: q("status"), patientId: q("patientId") }));
    if (p[2] === "replies" && post) {
      const b = await body();
      return reply(care.createReply({ patientId: b.patientId, text: b.text, messageId: b.messageId ?? null, channel: b.channel, mode: "manual", reason: "医生手写" }), 201);
    }
    if (p[2] === "alerts" && get) return reply(care.alerts({ status: q("status"), patientId: q("patientId") }));
    if (p[2] === "campaigns" && get) return reply(care.campaigns({ status: q("status"), patientId: q("patientId") }));
    if (p[2] === "campaigns" && post) return reply(care.createCampaign(await body()), 201);
    if (p[2] === "settings" && get) return reply(care.publicSettings());
    if (p[2] === "settings" && put) return reply(care.saveSettings(await body()));
    if (p[2] === "ingest" && post) return reply(care.ingest(await body()), 201);
    if (p[2] === "sync" && post) return reply(await care.syncKf());
  }
  if (p[2] === "settings" && p[3] === "test" && p.length === 4 && post) return reply(await care.testConnection(await body()));
  if (p[2] === "settings" && p[3] === "kf-accounts" && p.length === 4 && get) return reply(await care.kfAccounts());
  if (p[2] === "settings" && p[3] === "kf-link" && p.length === 4 && post) return reply(await care.kfLink());
  if (p[2] === "patients" && p.length === 4 && get) return reply(care.patientThread(p[3], q("limit")));
  if (p[2] === "patients" && p.length === 5 && p[4] === "settings") {
    if (get) return reply(care.patientSettings(p[3]));
    if (put) return reply(care.savePatientSettings(p[3], await body()));
  }
  if (p[2] === "messages" && p.length === 5 && post) {
    if (p[4] === "process") return reply(await care.processMessage(Number(p[3]), { force: true }));
    if (p[4] === "mark") return reply(care.markMessage(Number(p[3]), (await body()).status));
    if (p[4] === "assign") return reply(care.assignMessage(Number(p[3]), (await body()).patientId));
  }
  if (p[2] === "replies" && p.length === 4 && put) return reply(care.updateReply(p[3], await body()));
  if (p[2] === "replies" && p.length === 5 && post) {
    if (p[4] === "send") return reply(await care.sendReply(p[3], { confirmed: (await body()).confirmed === true }));
    if (p[4] === "discard") return reply(care.discardReply(p[3]));
  }
  if (p[2] === "alerts" && p.length === 5 && post && ["acknowledge", "resolve"].includes(p[4])) return reply(care.updateAlert(p[3], p[4], (await body()).note));
  if (p[2] === "campaigns" && p.length === 5 && post) return reply(care.campaignAction(p[3], p[4]));
  return false;
}
