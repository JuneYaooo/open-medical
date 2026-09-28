import { ModelBudgetFields } from '../model-budget-fields';
import { useEffect, useState } from "react";
import { api } from "../agent-runtime";
export function TeamModels({ current, refresh, disabled }) {
  const [profiles, setProfiles] = useState([]),
    [selected, setSelected] = useState(current.teamModels || []),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    id: "",
    provider: "openai-compatible",
    baseUrl: "",
    model: "",
    apiKey: "",
    contextWindow: null,
    maxTokens: 8192,
  });
  useEffect(() => {
    let alive = true;
    api("/api/model-profiles")
      .then((d) => {
        if (alive) setProfiles(d.profiles);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, []);
  async function execute(fn) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>团队模型与协作</summary>
      <p>
        保存多个模型连接，再授权当前任务可以调用哪些模型。未选择时，子任务沿用主模型。
      </p>
      <fieldset disabled={disabled || busy}>
        {profiles.map((p) => (
          <label className="workspace-checkbox" key={p.id}>
            <input
              type="checkbox"
              checked={selected.includes(p.id)}
              onChange={(e) =>
                setSelected(
                  e.target.checked
                    ? [...selected, p.id]
                    : selected.filter((id) => id !== p.id),
                )
              }
            />
            {p.id} · {p.provider} / {p.model}
          </label>
        ))}
        <button
          onClick={() =>
            execute(async () => {
              await api(`/api/workspaces/${current.id}/team-models`, "PUT", {
                profiles: selected,
                consent: true,
                revision: current.revision,
              });
              await refresh();
            })
          }
        >
          授权所选模型处理本任务资料
        </button>
        <details>
          <summary>添加或更新模型连接</summary>
          <label>编辑已保存连接<select value={profiles.some(p => p.id === form.id) ? form.id : ''}
            onChange={(e) => {
              const profile = profiles.find(p => p.id === e.target.value);
              setForm(profile ? { ...profile, apiKey: '' } : { id: '', provider: 'openai-compatible', baseUrl: '', model: '', apiKey: '', contextWindow: null, maxTokens: 8192 });
            }}><option value="">新建连接</option>{profiles.map(p => <option key={p.id} value={p.id}>{p.id} · {p.model}</option>)}</select></label>
          {[
            ["id", "连接 ID"],
            ["baseUrl", "接口地址"],
            ["model", "模型名称"],
            ["apiKey", "API Key"],
          ].map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type={key === "apiKey" ? "password" : "text"}
                value={form[key]}
                onChange={(e) => setForm({ ...form, [key]: e.target.value, ...(['model', 'baseUrl'].includes(key) ? { contextWindow: null } : {}) })}
              />
            </label>
          ))}
          <label>
            协议
            <select
              value={form.provider}
              onChange={(e) => setForm({ ...form, provider: e.target.value, contextWindow: null })}
            >
              {[
                "openai-compatible",
                "openai",
                "openai-responses",
                "deepseek",
                "anthropic",
                "local",
              ].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <ModelBudgetFields form={form} onChange={(changes) => setForm({ ...form, ...changes })} />
          <button
            onClick={() =>
              execute(async () => {
                const d = await api("/api/model-profiles", "PUT", form);
                setProfiles(d.profiles);
                setForm({ ...form, apiKey: "" });
              })
            }
          >
            保存连接
          </button>
        </details>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {current.runs.at(-1)?.children?.map((c) => (
        <details key={c.id}>
          <summary>
            {c.role} · {c.modelProfile || "主模型"} · {c.status}
          </summary>
          <p>{c.task}</p>
          <pre>{c.text || c.error || "等待结果"}</pre>
        </details>
      ))}
    </details>
  );
}
