import { LearningStats, HabitLedger, LearningDangerZone, memorySourceLabel } from "./learning-loop";
import { useEffect, useRef, useState } from "react";
import { api } from "./agent-runtime";
import { Check, Trash2, RotateCcw, Loader2, Sparkles, Eye } from "lucide-react";

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
  ["pending", "待确认"],
  ["open", "学习信号"],
  ["dismissed", "已忽略"],
];

export function DoctorProfilePanel() {
  const memoryGeneration = useRef(0);
  const [profile, setProfile] = useState(null);
  const [fields, setFields] = useState({});
  const [lists, setLists] = useState({});
  const [memories, setMemories] = useState([]);
  const [tab, setTab] = useState("pending");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modelConsent, setModelConsent] = useState(false);
  const [newMemory, setNewMemory] = useState("");

  const loadProfile = async (keepDraft = false) => {
    const value = await api("/api/doctor/profile");
    setProfile(value);
    if (!keepDraft) {
      setFields({
        specialty: value.fields?.specialty || "",
        note: value.fields?.note || "",
      });
      setLists(Object.fromEntries(LIST_FIELDS.map(([key]) => [key, value.fields?.[key] || []])));
    }
    return value;
  };
  const loadMemories = async (which = tab) => {
    const generation = ++memoryGeneration.current;
    const value = await api(`/api/doctor/memories?status=${which}`);
    if (generation === memoryGeneration.current) setMemories(value.memories);
  };
  useEffect(() => {
    loadProfile().catch((err) => setError(err.message));
  }, []);
  useEffect(() => {
    setMemories([]);
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
      setNotice("偏好已保存，之后整理时会参考。");
    } catch (err) {
      setError(err.message);

    } finally {
      setBusy(false);
    }
  };

  const memoryAction = async (id, action, body) => {
    setError("");
    try {
      await api(`/api/doctor/memories/${id}/${action}`, "POST", body || {});
      await Promise.all([loadMemories(), loadProfile(true)]);
      window.dispatchEvent(new Event("habits-changed"));
    } catch (err) {
      setError(err.message);
    }
  };
  const deleteMemory = async (id) => {
    setError("");
    try {
      await api(`/api/doctor/memories/${id}`, "DELETE");
      await Promise.all([loadMemories(), loadProfile(true)]);
      window.dispatchEvent(new Event("habits-changed"));
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
      const learned = !useModel && value.created.length > 0;
      setNotice(
        learned
          ? `记下了 ${value.created.length} 条习惯（你重复写过的说明），已生效；可在「我的习惯」编辑、停用或删除。`
          : value.created.length
            ? `模型归纳出 ${value.created.length} 条候选偏好，请在「待确认」中审核。`
            : useModel
              ? "模型没有归纳出新偏好。"
              : "同一条说明写过 2 次以上才会记成习惯；面向以后的话（如「以后都…」）写下时就已记住。",
      );
      const next = learned ? "open" : "pending";
      window.dispatchEvent(new Event("habits-changed"));
      setTab(next);
      await loadMemories(next);
      await loadProfile(true);
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
      setNotice("已添加到「我的习惯」。");
      await Promise.all([loadMemories(), loadProfile(true)]);
      window.dispatchEvent(new Event("habits-changed"));
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

  if (!profile) return error ? <div className="form-error" role="alert"><p>{error}</p><button className="secondary" onClick={() => { setError(""); loadProfile().catch(err => setError(err.message)); }}>重新加载医生档案</button></div> : <p className="muted" role="status">正在加载医生档案…</p>;

  return (
    <div className="doctor-panel">
      {error && (
        <p className="form-error" role="alert">
          {error} <button className="text-button" onClick={() => loadProfile().then(() => setError("")).catch(err => setError(err.message))}>放弃未保存偏好并载入最新配置</button>
        </p>
      )}
      {notice && <p className="form-notice" role="status">{notice}</p>}

      <details className="doctor-section">
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>
          结构化偏好表单（高级）
        </summary>
        <p className="muted">
          直接在对话里说出的偏好会记住，也可以在这里按科室、用药或写法分类填写。
        </p>
        {TEXT_FIELDS.map(([key, label, placeholder]) => (
          <label className="doctor-field" key={key}>
            <span>{label}</span>
            <input disabled={busy}
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
                <input disabled={busy}
                  aria-label={`${label} 第 ${index + 1} 条`}
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
            onClick={() => loadProfile().catch(err => setError(err.message))}
            disabled={busy}
          >
            <RotateCcw size={14} /> 重读
          </button>
        </div>
      </details>

      <LearningStats />
      <HabitLedger onChange={() => loadProfile(true)} />
      <details className="doctor-section doctor-summary-preview">
        <summary>整理时参考的偏好摘要</summary>
        <pre className="doctor-digest">{profile.digest || "暂无偏好，写下一条即可开始。"}</pre>
      </details>

      <section className="doctor-section">
        <h3>记忆</h3>
        <p className="muted">
          在对话里直接说你的偏好即可：说过的当场记住，学到的写法也会出现在「我的习惯」，随时可以编辑、停用或删除。
        </p>
        <div className="doctor-add">
          <input
            aria-label="直接写下一条偏好"
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
              <Sparkles size={14} /> 把重复写过的说明记成习惯
            </button>
            <label className="doctor-consent">
              <input
                type="checkbox"
                checked={modelConsent}
                onChange={(e) => setModelConsent(e.target.checked)}
              />
              允许把你写过的说明发送给当前模型，帮助归纳偏好
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
                  {memorySourceLabel(m)}
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
                : "暂无条目。"}
            </li>
          )}
        </ul>
      </section>
      <LearningDangerZone onClear={() => Promise.all([loadProfile(true), loadMemories(tab)])} />
    </div>
  );
}
