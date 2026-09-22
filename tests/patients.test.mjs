import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture } from "./helpers.mjs";
import { Store } from "../server/store.mjs";
import { backupDatabase } from "../scripts/backup.mjs";

test("patient creation links a clinical workspace session and supports revision-guarded updates", async (t) => {
  const f = await fixture(t);
  const created = await f.json("/api/patients", "POST", {
    name: "测试患者",
    gender: "female",
    birthYear: 1978,
    phone: "13800001111",
    groups: ["高血压"],
    tags: ["2型糖尿病"],
  });
  assert.equal(created.status, 201);
  const patient = created.data;
  assert.ok(patient.sessionId);
  const workspace = await f.json(`/api/sessions/${patient.sessionId}`);
  assert.equal(workspace.status, 200);
  assert.equal(workspace.data.patientId, patient.id);
  assert.match(workspace.data.title, /测试患者/);
  const list = (await f.json("/api/patients")).data.patients;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "测试患者");
  const conflict = await f.json(`/api/patients/${patient.id}`, "PATCH", {
    expectedRevision: patient.revision + 3,
    note: "过期的修改",
  });
  assert.equal(conflict.status, 409);
  const updated = await f.json(`/api/patients/${patient.id}`, "PATCH", {
    expectedRevision: patient.revision,
    note: "对青霉素过敏",
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.note, "对青霉素过敏");
  // Patient workspaces cannot be deleted from the workbench side.
  const deleteSession = await f.json(
    `/api/sessions/${patient.sessionId}`,
    "DELETE",
  );
  assert.equal(deleteSession.status, 409);
  const removed = await f.json(`/api/patients/${patient.id}`, "DELETE");
  assert.equal(removed.status, 200);
  assert.equal(
    (await f.json(`/api/sessions/${patient.sessionId}`)).status,
    404,
  );
  assert.equal((await f.json("/api/patients")).data.patients.length, 0);
});

test("ingest requires its own secret, matches patients by hint and deduplicates external ids", async (t) => {
  const withoutSecret = await fixture(t);
  assert.equal(
    (
      await withoutSecret.request("/api/ingest/messages", "POST", {
        messages: [],
      })
    ).status,
    503,
  );
  const f = await fixture(t, { ingestSecret: "s3cret" });
  const patient = (
    await f.json("/api/patients", "POST", {
      name: "消息患者",
      phone: "13800002222",
    })
  ).data;
  const ingest = (body, headers = {}) =>
    fetch(f.origin + "/api/ingest/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await ingest(
        { messages: [{ direction: "in", text: "hi" }] },
        { "x-ingest-secret": "wrong" },
      )
    ).status,
    401,
  );
  const first = await ingest(
    {
      messages: [
        {
          externalId: "w-1",
          patientHint: "13800002222",
          direction: "in",
          time: "2026-09-07T09:00:00Z",
          text: "今早血压 150/95",
        },
        {
          externalId: "w-2",
          patientHint: "不存在的人",
          direction: "in",
          text: "请问复诊时间",
        },
      ],
    },
    { "x-ingest-secret": "s3cret" },
  );
  assert.equal(first.status, 201);
  assert.deepEqual(await first.json(), {
    stored: 2,
    duplicates: 0,
    unassigned: 1,
  });
  const again = await ingest(
    {
      messages: [
        {
          externalId: "w-1",
          patientHint: "13800002222",
          direction: "in",
          text: "重复消息",
        },
      ],
    },
    { "x-ingest-secret": "s3cret" },
  );
  assert.deepEqual(await again.json(), {
    stored: 0,
    duplicates: 1,
    unassigned: 0,
  });
  const assigned = (await f.json(`/api/patients/${patient.id}/messages`)).data
    .messages;
  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].text, "今早血压 150/95");
  assert.equal(assigned[0].processed, false);
  const inbox = (await f.json("/api/inbox")).data.messages;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].patientHint, "不存在的人");
  const ack = await f.json(`/api/inbox/${inbox[0].id}/assign`, "POST", {
    patientId: patient.id,
  });
  assert.equal(ack.status, 200);
  assert.equal(
    (
      await f.json(`/api/inbox/${inbox[0].id}/assign`, "POST", {
        patientId: patient.id,
      })
    ).status,
    409,
  );
  // Manual paste from the UI uses the token route and lands on the patient.
  const manual = await f.json(`/api/patients/${patient.id}/messages`, "POST", {
    messages: [{ direction: "out", text: "明天上午复诊，请空腹" }],
  });
  assert.equal(manual.status, 201);
  const messages = (await f.json(`/api/patients/${patient.id}/messages`)).data
    .messages;
  assert.equal(messages.length, 3);
  assert.ok(
    messages.every((m) => m.channel === "manual" || m.channel === "ingest"),
  );
});

test("follow-up due date creates a reminder, auto-digests consented messages and pauses on failure", async (t) => {
  let now = Date.now();
  let calls = 0;
  const provider = {
    apiKey: "synthetic",
    model: "mock",
    async complete(messages, tools, { onDelta }) {
      calls++;
      if (calls >= 2) throw new Error("模拟模型故障");
      onDelta("记录摘要：血压升高，需复诊。");
      return {
        message: { role: "assistant", content: "记录摘要：血压升高，需复诊。" },
        usage: { total_tokens: 7 },
      };
    },
  };
  const f = await fixture(t, {
    provider,
    ingestSecret: "s3cret",
    followupOptions: { now: () => now, autoStart: false },
  });
  const patient = (
    await f.json("/api/patients", "POST", {
      name: "随访患者",
      phone: "13900003333",
    })
  ).data;
  const due = new Date(now + 1000).toISOString();
  const job = (
    await f.json(`/api/patients/${patient.id}/followups`, "POST", {
      name: "血压随访",
      intervalDays: 7,
      firstDueAt: due,
      checklist: ["血压记录", "用药依从性"],
      externalConsent: true,
    })
  ).data;
  assert.equal(job.status, "active");
  now += 2000;
  await f.server.followups.tick();
  assert.equal(calls, 0);
  assert.equal((await f.json("/api/reminders")).data.reminders.length, 1);
  // Ingest messages and let the next occurrence auto-digest them. The first
  // occurrence already advanced nextDue by one full interval, so jump 8 days.
  await fetch(f.origin + "/api/ingest/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ingest-secret": "s3cret",
    },
    body: JSON.stringify({
      messages: [
        {
          externalId: "f-1",
          patientHint: "13900003333",
          direction: "in",
          text: "这两天头晕，血压 160/100",
        },
      ],
    }),
  });
  now += 8 * 86400000 + 2000;
  await f.server.followups.tick();
  assert.equal(calls, 1);
  const messages = (await f.json(`/api/patients/${patient.id}/messages`)).data
    .messages;
  assert.ok(messages.every((m) => m.processed));
  let jobs = (await f.json(`/api/patients/${patient.id}/followups`)).data.jobs;
  assert.equal(jobs[0].status, "active");
  assert.equal(jobs[0].history.at(-1).digest, true);
  const session = (await f.json(`/api/sessions/${patient.sessionId}`)).data;
  assert.ok(
    session.messages.some((m) => m.content.includes("记录摘要：血压升高")),
  );
  // Provider failure pauses the plan instead of silently replaying it.
  await fetch(f.origin + "/api/ingest/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ingest-secret": "s3cret",
    },
    body: JSON.stringify({
      messages: [
        {
          externalId: "f-2",
          patientHint: "13900003333",
          direction: "in",
          text: "今晚胸闷出汗",
        },
      ],
    }),
  });
  now += 7 * 86400000 + 2000;
  await f.server.followups.tick();
  jobs = (await f.json(`/api/patients/${patient.id}/followups`)).data.jobs;
  assert.equal(jobs[0].status, "paused");
  assert.ok(jobs[0].lastError);
  const resumed = await f.json(
    `/api/patients/${patient.id}/followups/${job.id}`,
    "PATCH",
    { revision: jobs[0].revision, status: "active" },
  );
  assert.equal(resumed.status, 200);
  assert.ok(resumed.data.nextDue > now);
  // tick 1 + tick 2 + the failed tick 3 each left one reminder.
  assert.equal((await f.json("/api/reminders")).data.reminders.length, 3);
});

test("follow-up without standing consent reminds the doctor instead of sending messages", async (t) => {
  let now = Date.now();
  let calls = 0;
  const provider = {
    apiKey: "synthetic",
    model: "mock",
    async complete() {
      calls++;
      return { message: { role: "assistant", content: "不应被调用" } };
    },
  };
  const f = await fixture(t, {
    provider,
    followupOptions: { now: () => now, autoStart: false },
  });
  const patient = (
    await f.json("/api/patients", "POST", { name: "未授权患者" })
  ).data;
  await f.json(`/api/patients/${patient.id}/messages`, "POST", {
    messages: [{ direction: "in", text: "最近血糖偏高" }],
  });
  await f.json(`/api/patients/${patient.id}/followups`, "POST", {
    name: "血糖随访",
    intervalDays: 1,
    firstDueAt: new Date(now + 1000).toISOString(),
    checklist: [],
    externalConsent: false,
  });
  now += 2000;
  await f.server.followups.tick();
  assert.equal(calls, 0);
  const messages = (await f.json(`/api/patients/${patient.id}/messages`)).data
    .messages;
  assert.ok(messages.every((m) => !m.processed));
  const reminders = (await f.json("/api/reminders")).data.reminders;
  assert.equal(reminders.length, 1);
  const ack = await f.json(`/api/reminders/${reminders[0].id}/ack`, "POST", {});
  assert.equal(ack.status, 200);
  assert.equal((await f.json("/api/reminders")).data.reminders.length, 0);
});

test("manual digest requires consent, marks messages processed and produces a reviewable artifact", async (t) => {
  let round = 0;
  const provider = {
    apiKey: "synthetic",
    model: "mock",
    async complete(messages, tools, { onDelta }) {
      onDelta("整理中");
      round++;
      if (round === 1)
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c1",
                function: {
                  name: "make_review_checklist",
                  arguments: JSON.stringify({
                    title: "患者消息跟进清单",
                    items: ["确认头晕是否持续", "复测血压"],
                  }),
                },
              },
            ],
          },
          usage: { total_tokens: 11 },
        };
      return {
        message: { role: "assistant", content: "消息已整理为记录草稿。" },
        usage: { total_tokens: 3 },
      };
    },
  };
  const f = await fixture(t, { provider });
  const patient = (await f.json("/api/patients", "POST", { name: "摘要患者" }))
    .data;
  await f.json(`/api/patients/${patient.id}/messages`, "POST", {
    messages: [{ direction: "in", text: "今天开始吃新药后有点头晕" }],
  });
  const noConsent = await f.json(
    `/api/patients/${patient.id}/messages/digest`,
    "POST",
    {},
  );
  assert.equal(noConsent.status, 412);
  const digest = await f.json(
    `/api/patients/${patient.id}/messages/digest`,
    "POST",
    { externalConsent: true },
  );
  assert.equal(digest.status, 200);
  assert.equal(digest.data.status, "completed");
  const messages = (await f.json(`/api/patients/${patient.id}/messages`)).data
    .messages;
  assert.ok(messages.every((m) => m.processed));
  const session = (await f.json(`/api/sessions/${patient.sessionId}`)).data;
  const checklist = session.artifacts.find((a) => a.type === "checklist");
  assert.ok(checklist);
  assert.equal(checklist.status, "draft");
  const review = await f.json(
    `/api/sessions/${patient.sessionId}/artifacts/${checklist.id}/review`,
    "POST",
    {
      version: checklist.version,
      reviewer: "dr-li",
      note: "已核对原文",
      decision: "approved",
      attested: true,
    },
  );
  assert.equal(review.status, 200);
  assert.equal(review.data.status, "approved");
});

test("draft_treatment_review produces a bounded draft artifact through the model tool loop", async (t) => {
  let round = 0;
  const provider = {
    apiKey: "synthetic",
    model: "mock",
    async complete(messages, tools) {
      round++;
      if (round === 1) {
        assert.ok(
          tools.some((tool) => tool.function.name === "draft_treatment_review"),
        );
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "t1",
                function: {
                  name: "draft_treatment_review",
                  arguments: JSON.stringify({
                    summary:
                      "患者目前使用二甲双胍控制血糖，最近记录提示依从性下降。",
                    concerns: ["两周内两次空腹血糖高于目标值"],
                    infoGaps: ["材料未记录糖化血红蛋白"],
                    questions: ["是否需要调整复查频率"],
                  }),
                },
              },
            ],
          },
          usage: { total_tokens: 20 },
        };
      }
      return {
        message: { role: "assistant", content: "已生成参考意见草稿。" },
        usage: { total_tokens: 5 },
      };
    },
  };
  const f = await fixture(t, { provider });
  const patient = (await f.json("/api/patients", "POST", { name: "评估患者" }))
    .data;
  const file = await f.json(
    `/api/sessions/${patient.sessionId}/files`,
    "POST",
    {
      name: "病例.txt",
      text: "2026-09-01 空腹血糖 8.9 mmol/L\n2026-09-05 空腹血糖 9.4 mmol/L",
    },
  );
  assert.equal(file.status, 201);
  const run = await f.chat(patient.sessionId, "请评估治疗方案", {
    mode: "model",
    externalConsent: true,
    fileIds: [file.data.id],
  });
  assert.equal(run.events.at(-1).type, "message.complete");
  const session = (await f.json(`/api/sessions/${patient.sessionId}`)).data;
  const artifact = session.artifacts.find((a) => a.type === "treatment_review");
  assert.ok(artifact);
  assert.equal(artifact.status, "draft");
  assert.equal(artifact.provenance, "model_draft");
  assert.ok(artifact.limitations[0].includes("必须由医生复核确认"));
  assert.ok(!JSON.stringify(session).includes("providerMessages"));
  const reviewed = await f.json(
    `/api/sessions/${patient.sessionId}/artifacts/${artifact.id}/review`,
    "POST",
    {
      version: artifact.version,
      reviewer: "dr-wang",
      note: "参考意见与材料一致",
      decision: "approved",
      attested: true,
    },
  );
  assert.equal(reviewed.status, 200);
});

test("schema 2 databases upgrade in place and remain backup compatible", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "medical-migration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "old.sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, action TEXT NOT NULL, time TEXT NOT NULL, detail TEXT NOT NULL);
    CREATE TABLE event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, time TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX event_log_session ON event_log(session_id,id);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version','2');`);
  legacy.prepare("INSERT INTO sessions VALUES (?,?)").run(
    "legacy-1",
    JSON.stringify({
      id: "legacy-1",
      title: "旧版会话",
      createdAt: 1,
      updatedAt: 1,
      revision: 0,
      messages: [],
      files: [],
      artifacts: [],
      runs: [],
    }),
  );
  legacy.close();
  const store = new Store(file);
  try {
    assert.equal(store.get("legacy-1").title, "旧版会话");
    assert.equal(
      store.db
        .prepare("SELECT value FROM meta WHERE key=?")
        .get("schema_version").value,
      "8",
    );
    for (const table of [
      "patients",
      "patient_messages",
      "follow_ups",
      "reminders",
      "doctor_profile",
      "doctor_memories",
      "literature_cache",
      "care_tasks",
    ])
      store.db.prepare(`SELECT COUNT(*) FROM ${table}`).get();
    const backup = backupDatabase(file, join(dir, "backup.sqlite"));
    const check = new DatabaseSync(backup, { readOnly: true });
    assert.equal(
      check.prepare("SELECT value FROM meta WHERE key=?").get("schema_version")
        .value,
      "8",
    );
    check.close();
  } finally {
    store.close();
  }
});

for (const automatic of [false, true]) {
  for (const [label, texts, consumed] of [
    [
      "count overflow",
      Array.from({ length: 70 }, (_, i) => `synthetic-message-${i}`),
      50,
    ],
    [
      "character overflow",
      Array.from({ length: 3 }, (_, i) => `${i}`.repeat(5000)),
      2,
    ],
  ]) {
    test(`${automatic ? "scheduled" : "manual"} digest marks only its consumed snapshot: ${label} and concurrent arrival`, async (t) => {
      let f, patient;
      const provider = {
        apiKey: "synthetic",
        model: "mock",
        async complete() {
          await f.json(`/api/patients/${patient.id}/messages`, "POST", {
            messages: [{ direction: "in", text: "concurrent-new-message" }],
          });
          return {
            message: { role: "assistant", content: "已整理输入消息。" },
            usage: { total_tokens: 1 },
          };
        },
      };
      f = await fixture(t, { provider, followupOptions: { autoStart: false } });
      patient = (
        await f.json("/api/patients", "POST", { name: "合成摘要患者" })
      ).data;
      await f.json(`/api/patients/${patient.id}/messages`, "POST", {
        messages: texts.map((text) => ({ direction: "in", text })),
      });
      const before = (await f.json(`/api/patients/${patient.id}/messages`)).data
        .messages;
      const ordered = automatic ? [...before].reverse() : before;
      const expectedIds = ordered
        .slice(0, consumed)
        .map((m) => m.id)
        .sort((a, b) => a - b);
      if (automatic) {
        const job = (
          await f.json(`/api/patients/${patient.id}/followups`, "POST", {
            name: "快照测试",
            intervalDays: 7,
            firstDueAt: new Date(Date.now() + 1000).toISOString(),
            externalConsent: true,
          })
        ).data;
        assert.equal((await f.server.followups.execute(job)).digest, true);
      } else {
        const response = await f.json(
          `/api/patients/${patient.id}/messages/digest`,
          "POST",
          { externalConsent: true },
        );
        assert.equal(response.data.status, "completed");
      }
      const after = (await f.json(`/api/patients/${patient.id}/messages`)).data
        .messages;
      assert.deepEqual(
        after
          .filter((m) => m.processed)
          .map((m) => m.id)
          .sort((a, b) => a - b),
        expectedIds,
      );
      assert.equal(
        after.filter((m) => !m.processed).length,
        texts.length + 1 - consumed,
      );
      assert.equal(
        after.find((m) => m.text === "concurrent-new-message").processed,
        false,
      );
    });
  }
}

test("oversized first digest input is rejected without executing or marking any message", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    provider: {
      apiKey: "synthetic",
      model: "mock",
      complete() {
        calls++;
        throw new Error("unexpected");
      },
    },
    followupOptions: { autoStart: false },
  });
  const patient = (
    await f.json("/api/patients", "POST", { name: "超长合成输入" })
  ).data;
  const db = f.server.followups.store.db;
  db.prepare(
    "INSERT INTO patient_messages(patient_id,channel,direction,time,external_id,processed,data) VALUES (?,?,?,?,?,0,?)",
  ).run(
    patient.id,
    "manual",
    "in",
    new Date().toISOString(),
    null,
    JSON.stringify({ text: "x".repeat(12001) }),
  );
  const manual = await f.json(
    `/api/patients/${patient.id}/messages/digest`,
    "POST",
    { externalConsent: true },
  );
  assert.equal(manual.status, 422);
  const job = (
    await f.json(`/api/patients/${patient.id}/followups`, "POST", {
      name: "超长测试",
      intervalDays: 7,
      firstDueAt: new Date(Date.now() + 1000).toISOString(),
      externalConsent: true,
    })
  ).data;
  assert.equal((await f.server.followups.execute(job)).status, "failed");
  assert.equal(calls, 0);
  assert.equal(
    db
      .prepare("SELECT processed FROM patient_messages WHERE patient_id=?")
      .get(patient.id).processed,
    0,
  );
});

for (const status of ["failed", "cancelled"]) {
  test(`scheduled digest ${status} leaves the entire snapshot pending`, async (t) => {
    const f = await fixture(t, {
      provider: { apiKey: "synthetic", model: "mock" },
      followupOptions: { autoStart: false },
    });
    const patient = (
      await f.json("/api/patients", "POST", { name: "失败合成输入" })
    ).data;
    await f.json(`/api/patients/${patient.id}/messages`, "POST", {
      messages: Array.from({ length: 70 }, (_, i) => ({
        direction: "in",
        text: `pending-${i}`,
      })),
    });
    const job = (
      await f.json(`/api/patients/${patient.id}/followups`, "POST", {
        name: "失败测试",
        intervalDays: 7,
        firstDueAt: new Date(Date.now() + 1000).toISOString(),
        externalConsent: true,
      })
    ).data;
    f.server.followups.runtime = {
      provider: { apiKey: "synthetic" },
      prepare() {
        return { run: { id: "synthetic-run" } };
      },
      async execute() {
        return { status, runId: "synthetic-run" };
      },
    };
    assert.equal((await f.server.followups.execute(job)).status, "failed");
    const messages = (await f.json(`/api/patients/${patient.id}/messages`)).data
      .messages;
    assert.equal(messages.length, 70);
    assert.ok(messages.every((m) => !m.processed));
  });
}

for (const cancel of [false, true]) {
  test(`manual digest ${cancel ? "cancelled" : "failed"} leaves all inputs pending`, async (t) => {
    let f, patient;
    const provider = {
      apiKey: "synthetic",
      model: "mock",
      async complete() {
        if (!cancel) throw new Error("synthetic digest failure");
        const response = await f.json(
          `/api/chat/${patient.sessionId}/cancel`,
          "POST",
          {},
        );
        assert.equal(response.data.cancelled, true);
        return {
          message: { role: "assistant", content: "late synthetic result" },
          usage: { total_tokens: 1 },
        };
      },
    };
    f = await fixture(t, { provider });
    patient = (
      await f.json("/api/patients", "POST", { name: "手动失败合成输入" })
    ).data;
    await f.json(`/api/patients/${patient.id}/messages`, "POST", {
      messages: Array.from({ length: 70 }, (_, i) => ({
        direction: "in",
        text: `pending-${i}`,
      })),
    });
    const result = await f.json(
      `/api/patients/${patient.id}/messages/digest`,
      "POST",
      { externalConsent: true },
    );
    assert.equal(result.data.status, cancel ? "cancelled" : "failed");
    const messages = (await f.json(`/api/patients/${patient.id}/messages`)).data
      .messages;
    assert.equal(messages.length, 70);
    assert.ok(messages.every((m) => !m.processed));
  });
}
