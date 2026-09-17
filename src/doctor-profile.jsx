import { useEffect, useState } from "react";
import { api } from "./agent-runtime";
import { Check, Pin, PinOff, Trash2, RotateCcw, Loader2, Sparkles, Eye } from "lucide-react";

const TEXT_FIELDS = [
  ["specialty", "科室", "如：心内科"],
  ["note", "补充说明", "其他想固定的习惯"],
];
const LIST_FIELDS = [
  ["medicationHabits", "常用药物与剂量习惯"],
  ["examPanels", "常用检查组合"],
  ["followupPreferences", "随访偏好"],
  ["documentationStyle", "病历文风偏好"],
  ["guidelineSources", "常用指南来源"],
  ["terminology", "术语与缩写习惯"],
];
const MEMORY_TABS = [
  ["confirmed", "生效中"],
  ["pending", "待确认"],
  ["open", "学习信号"],
  ["dismissed", "已忽略"],
];

export function DoctorProfilePanel() {
  const [profile, setProfile] = useState(null);
  const [fields, setFields] = useState({});
  const [lists, setLists] = useState({});
  const [memories, setMemories] = useState([]);
  const [tab, setTab] = useState("confirmed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modelConsent, setModelConsent] = useState(false);
  const [newMemory, setNewMemory] = useState("");

  const loadProfile = async () => {
    const value = await api("/api/doctor/profile");
    setProfile(value);
    setFields({
      specialty: value.fields?.specialty || "",
      note: value.fields?.note || "",
    });
    setLists(Object.fromEntries(LIST_FIELDS.map(([key]) => [key, value.fields?.[key] || []])));
    return value;
  };
  const loadMemories = async (which = tab) => {
    const status = which === "confirmed" ? "" : which;
    const value = await api(
      `/api/doctor/memories${which === "confirmed" ? "?status=confirmed" : `?status=${status}`}`,
    );
    setMemories(value.memories);
  };
  useEffect(() => {
    loadProfile().catch((err) => setError(err.message));
  }, []);
  useEffect(() => {
    loadMemories(tab).catch((err) => setError(err.message));
  }, [tab]);

  const saveProfile = async () => {
    setBusy(true);
    setError("");
    try {
      const value = await api("/api/doctor/profile", "PATCH", {
        expectedRevision: profile.revision,
        ...fields,
        ...lists,
      });
      setProfile(value);
      setNotice("偏好已保存，会注入后续每一次医疗任务。");
    } catch (err) {
      setError(err.message);
      loadProfile().catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const memoryAction = async (id, action, body) => {
    setError("");
    try {
      await api(`/api/doctor/memories/${id}/${action}`, "POST", body || {});
      await Promise.all([loadMemories(), loadProfile()]);
    } catch (err) {
      setError(err.message);
    }
  };
  const deleteMemory = async (id) => {
    setError("");
    try {
      await api(`/api/doctor/memories/${id}`, "DELETE");
      await Promise.all([loadMemories(), loadProfile()]);
    } catch (err) {
      setError(err.message);
    }
  };
  const consolidate = async (useModel) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = useModel
        ? await api("/api/doctor/consolidate/model", "POST", {
            externalConsent: modelConsent === true,
          })
        : await api("/api/doctor/consolidate", "POST");
      setNotice(
        value.created.length
          ? `已归纳出 ${value.created.length} 条候选偏好，请在「待确认」中审核。`
          : useModel
            ? "模型没有归纳出新偏好。"
            : "重复出现≥2次的信号才会自动归纳；其余请在「学习信号」中手动确认。",
      );
      setTab("pending");
      await loadMemories("pending");
      await loadProfile();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const addMemory = async () => {
    if (!newMemory.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/doctor/memories", "POST", { content: newMemory });
      setNewMemory("");
      setTab("confirmed");
      await Promise.all([loadMemories("confirmed"), loadProfile()]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const setListItem = (key, index, value) =>
    setLists((prev) => ({
      ...prev,
      [key]: prev[key].map((item, i) => (i === index ? value : item)),
    }));
  const addListItem = (key) =>
    setLists((prev) => ({ ...prev, [key]: [...prev[key], ""] }));
  const removeListItem = (key, index) =>
    setLists((prev) => ({
      ...prev,
      [key]: prev[key].filter((_, i) => i !== index),
    }));

  if (!profile) return <p className="muted">正在加载医生档案…</p>;

  return (
    <div className="doctor-panel">
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="form-notice">{notice}</p>}

      <details className="doctor-section">
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>
          结构化偏好表单（高级）
        </summary>
        <p className="muted">
          平时无需手动编辑：直接在对话里表达偏好，AI 会提议记忆、你确认后生效。此处表单用于微调「医生偏好档案」注入的系统指令（≤800 字）。
        </p>
        {TEXT_FIELDS.map(([key, label, placeholder]) => (
          <label className="doctor-field" key={key}>
            <span>{label}</span>
            <input
              value={fields[key] || ""}
              placeholder={placeholder}
              onChange={(e) =>
                setFields((prev) => ({ ...prev, [key]: e.target.value }))
              }
            />
          </label>
        ))}
        {LIST_FIELDS.map(([key, label]) => (
          <fieldset className="doctor-list" key={key}>
            <legend>{label}</legend>
            {(lists[key] || []).map((item, index) => (
              <div className="doctor-list-row" key={index}>
                <input
                  value={item}
                  onChange={(e) => setListItem(key, index, e.target.value)}
                />
                <button
                  className="icon-button"
                  title="删除此条"
                  onClick={() => removeListItem(key, index)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <button
              className="text-button"
              onClick={() => addListItem(key)}
              disabled={(lists[key] || []).length >= 30}
            >
              + 添加
            </button>
          </fieldset>
        ))}
        <div className="doctor-actions">
          <button onClick={saveProfile} disabled={busy}>
            {busy ? <Loader2 className="spin" size={15} /> : null}
            保存偏好
          </button>
          <button
            className="secondary"
            onClick={() => loadProfile().catch(() => {})}
            disabled={busy}
          >
            <RotateCcw size={14} /> 重读
          </button>
        </div>
      </details>

      <section className="doctor-section">
        <h3>当前注入摘要预览</h3>
        <pre className="doctor-digest">
          {profile.digest || "（暂无偏好内容；填写上方偏好或确认记忆条目后会自动生成）"}
        </pre>
      </section>

      <section className="doctor-section">
        <h3>记忆</h3>
        <p className="muted">
          在对话里直接说你的偏好即可：AI 会用 doctor_memory_propose
          存为「待确认」，你在这里确认后自动注入后续每次任务；不合适的忽略或删除。
        </p>
        <div className="doctor-add">
          <input
            value={newMemory}
            placeholder="直接写下一条确定的偏好，保存即生效"
            onChange={(e) => setNewMemory(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addMemory()}
          />
          <button onClick={addMemory} disabled={busy || !newMemory.trim()}>
            添加
          </button>
        </div>
        <nav className="doctor-tabs" aria-label="记忆筛选">
          {MEMORY_TABS.map(([id, label]) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
            >
              {label}
              {id === "pending" && profile.counts.pending > 0 && (
                <em>{profile.counts.pending}</em>
              )}
              {id === "open" && profile.counts.openSignals > 0 && (
                <em>{profile.counts.openSignals}</em>
              )}
            </button>
          ))}
        </nav>
        {tab === "open" && (
          <div className="doctor-consolidate">
            <button
              className="secondary"
              onClick={() => consolidate(false)}
              disabled={busy}
            >
              <Sparkles size={14} /> 归纳重复信号（本地）
            </button>
            <label className="doctor-consent">
              <input
                type="checkbox"
                checked={modelConsent}
                onChange={(e) => setModelConsent(e.target.checked)}
              />
              允许把信号原文发送给所配置模型以辅助归纳
            </label>
            <button
              onClick={() => consolidate(true)}
              disabled={busy || !modelConsent}
            >
              模型辅助归纳
            </button>
          </div>
        )}
        <ul className="doctor-memories">
          {memories.map((m) => (
            <li key={m.id} className={`memory memory-${m.status}`}>
              <div className="memory-main">
                <p>{m.content}</p>
                <small>
                  {m.kind === "explicit"
                    ? "手动添加"
                    : m.kind === "consolidated"
                      ? m.source?.mode === "model"
                        ? "模型归纳"
                        : `重复信号 ×${m.count}`
                      : `观察信号 ×${m.count}`}
                  {m.topic ? ` · ${m.topic}` : ""}
                  {m.source?.type ? ` · 来自${sourceLabel(m.source.type)}` : ""}
                </small>
              </div>
              <div className="memory-actions">
                {(m.status === "pending" || m.status === "open") && (
                  <button
                    className="icon-button"
                    title="确认生效"
                    onClick={() => memoryAction(m.id, "confirm")}
                  >
                    <Check size={15} />
                  </button>
                )}
                {m.status === "confirmed" && (
                  <button
                    className="icon-button"
                    title={m.pinned ? "取消置顶" : "置顶"}
                    onClick={() => memoryAction(m.id, "pin", { pinned: !m.pinned })}
                  >
                    {m.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                  </button>
                )}
                {m.status !== "dismissed" ? (
                  <button
                    className="icon-button"
                    title="忽略"
                    onClick={() => memoryAction(m.id, "dismiss")}
                  >
                    <Eye size={15} />
                  </button>
                ) : (
                  <button
                    className="icon-button"
                    title="重新激活"
                    onClick={() => memoryAction(m.id, "confirm")}
                  >
                    <RotateCcw size={15} />
                  </button>
                )}
                <button
                  className="icon-button danger"
                  title="删除"
                  onClick={() => deleteMemory(m.id)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </li>
          ))}
          {!memories.length && (
            <li className="memory-empty">
              {tab === "open"
                ? "暂无学习信号。拒绝草稿复核或修订产物时会自动记录，供归纳为偏好。"
                : tab === "confirmed"
                  ? "还没有生效的偏好。写入结构化偏好或确认候选条目。"
                  : "暂无条目。"}
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}

function sourceLabel(type) {
  if (type === "review_rejected") return "复核拒绝";
  if (type === "artifact_edited") return "草稿修订";
  return type || "手动";
}
