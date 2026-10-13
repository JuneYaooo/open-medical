import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { DeepSeekProvider } from "../server/provider.mjs";
test(
  "personal replay requires cloud consent, redacts sources, isolates target and writes only aggregate results",
  { timeout: 30000 },
  async (t) => {
    const provider = new DeepSeekProvider({
        apiKey: "synthetic",
        model: "replay-test",
      }),
      captured = [];
    provider.complete = async (messages) => {
      captured.push(JSON.stringify(messages));
      const results = messages
        .filter((m) => m.role === "tool")
        .map((m) => JSON.parse(m.content));
      const call = (name, args) => ({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: `call-${messages.length}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      });
      if (results.some((r) => r.status === "pending"))
        return { message: { role: "assistant", content: "完成。" } };
      const batch = results.findLast((r) => r.materials || r.intakeNotesSaved);
      if (batch?.materials)
        return call("save_intake_notes", {
          batchId: batch.batchId,
          notes: "某患者 2000-01-01 高血压",
        });
      if (!batch?.complete) return call("read_intake_batch", {});
      if (!results.some((r) => Object.hasOwn(r, "habitIds")))
        return call("read_personal_context", {});
      return call("patient_create_propose", {
        name: "某患者",
        summary: "合成复测",
        diagnoses: [
          { name: "高血压", status: "confirmed", date: "2000-01-01" },
        ],
      });
    };
    const f = await fixture(t, { provider }),
      session = await f.session("合成资料");
    const uploaded = await f.json(`/api/sessions/${session.id}/files`, "POST", {
      name: "来源.txt",
      text: "姓名：隐私金丝雀甲\n联系电话：13800138000\n2026-09-01 高血压。",
    });
    const action = f.server.pending.propose({
      type: "patient-create",
      summary: "基线",
      payload: {
        name: "隐私金丝雀甲",
        phone: "13800138000",
        sourceSessionId: session.id,
        sourceFileIds: [uploaded.data.id],
        diagnoses: [
          {
            name: "高血压",
            status: "confirmed",
            date: "2026-09-01",
            note: "GOLD_ONLY_PHRASE",
          },
        ],
      },
    });
    f.server.pending.confirm(action.id);
    assert.equal(
      (await f.json("/api/learning/regression", "POST", {})).status,
      400,
    );
    const started = await f.json("/api/learning/regression", "POST", {
      consent: true,
    });
    assert.equal(started.status, 202, JSON.stringify(started.data));
    let state;
    for (let i = 0; i < 200; i++) {
      state = (await f.json("/api/learning/regression")).data;
      if (state.run?.status !== "running") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(state.run.status, "completed", state.run.message);
    assert.equal(state.run.completed, 1);
    assert.doesNotMatch(
      captured.join("\n"),
      /隐私金丝雀甲|13800138000|2026-09-01|GOLD_ONLY_PHRASE/,
    );
    assert.equal(f.server.patients.all().length, 1);
    assert.equal(f.server.pending.reviewLog.stats().count, 1);
    assert.doesNotMatch(
      JSON.stringify(state),
      /隐私金丝雀甲|GOLD_ONLY_PHRASE|高血压/,
    );
  },
);
