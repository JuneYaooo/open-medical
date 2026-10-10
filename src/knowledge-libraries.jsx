import { useEffect, useState } from "react";
import { api } from "./agent-runtime";
import { KnowledgeView } from "./knowledge";
import { EducationTools } from "./education-materials";
import "./medical-modules.css";
export function KnowledgeLibraries({ onOpenTask }) {
  const [loading, setLoading] = useState(true);
  const [libraries, setLibraries] = useState([]),
    [selected, setSelected] = useState(null),
    [form, setForm] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [deleting, setDeleting] = useState(null),
    [notice, setNotice] = useState("");
  const [materialsVersion, setMaterialsVersion] = useState(0);
  const load = async () => {
    const data = await api("/api/knowledge/collections");
    setLibraries(data.collections);
  };
  useEffect(() => {
    load()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (deleting) document.getElementById("delete-library-title")?.scrollIntoView({ block: "center" });
  }, [deleting]);
  const save = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const item = await api(
        `/api/knowledge/collections/${encodeURIComponent(form.name.trim())}`,
        "PUT",
        { ...form, expectedRevision: form.revision || 0 },
      );
      await load();
      setForm(null);
      if (selected) setSelected(item);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const prepareDelete = async (name) => {
    setError("");
    setNotice("");
    try {
      const data = await api("/api/knowledge/collections");
      setLibraries(data.collections);
      const item = data.collections.find(item => item.name === name);
      if (!item) throw new Error("知识库已不存在，请刷新列表");
      setDeleting(item);
    } catch (e) { setError(e.message); }
  };
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api(
        `/api/knowledge/collections/${encodeURIComponent(deleting.name)}`,
        "DELETE", { deletionToken: deleting.deletionToken },
      );
      if (selected?.name === deleting.name) setSelected(null);
      if (form?.name === deleting.name) setForm(null);
      setDeleting(null);
      setNotice(result.warning || "知识库已删除");
      await load();
    } catch (e) { setError(e.message); setDeleting(null); }
    finally { setBusy(false); }
  };
  const startCreate = () => {
    setError("");
    setForm({
      name: "",
      description: "",
      whenToUse: "",
      limitations: "",
      revision: 0,
      isNew: true,
    });
  };
  return (
    <div className="module-view library-hub">
      {!selected && (
        <div className="module-head">
          <div>
            <h1>本地知识库</h1>
            <p className="module-phase">
              把常用指南、书籍和科室资料整理成自己的参考库。
            </p>
          </div>
          <button className="primary" onClick={startCreate}>
            新建知识库
          </button>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error} <button className="text-button" onClick={() => { setLoading(true); load().then(() => setError("")).catch(e => setError(e.message)).finally(() => setLoading(false)); }}>重新加载知识库</button>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {deleting && (
        <section className="module-card library-delete-confirm" role="alertdialog" aria-labelledby="delete-library-title" aria-describedby="delete-library-description">
          <h2 id="delete-library-title">删除“{deleting.name}”？</h2>
          <p id="delete-library-description">
            将删除此知识库及其中的 {deleting.documentCount} 份资料和检索索引，无法撤销。
            患者档案、历史任务和电脑上的原始文件会保留。历史回答中的知识库出处可能无法再打开。
          </p>
          <div className="toolbar-actions">
            <button className="secondary" disabled={busy} onClick={() => setDeleting(null)}>取消</button>
            <button className="library-delete-button" disabled={busy} onClick={remove}>{busy ? "正在删除…" : "确认删除知识库"}</button>
          </div>
        </section>
      )}
      {form && (
        <form className="module-card library-form" onSubmit={save}>
          <h2>{form.isNew ? "新建知识库" : "编辑知识库说明"}</h2>
          <fieldset disabled={busy}>
            <label>
              知识库名称
              <input
                required
                maxLength={60}
                disabled={!form.isNew}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例如：肝癌诊疗参考"
              />
            </label>
            <label>
              收录什么
              <textarea
                required
                maxLength={1000}
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                placeholder="说明资料内容与来源范围"
              />
            </label>
            <label>
              什么时候用
              <textarea
                required
                maxLength={1000}
                value={form.whenToUse}
                onChange={(e) =>
                  setForm({ ...form, whenToUse: e.target.value })
                }
                placeholder="例如：复核肝癌分期依据、查阅治疗与随访指南时"
              />
            </label>
            <label>
              不适用范围或注意事项
              <textarea
                maxLength={1000}
                value={form.limitations}
                onChange={(e) =>
                  setForm({ ...form, limitations: e.target.value })
                }
                placeholder="例如：仅供成人参考；需核对指南版本"
              />
            </label>
            <div className="toolbar-actions">
              <button
                className="secondary"
                type="button"
                onClick={() => setForm(null)}
              >
                取消
              </button>
              <button className="primary" type="submit">
                {busy ? "保存中…" : "保存知识库"}
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {selected ? (
        <>
          <div className="library-topbar">
            <button
              className="text-button"
              onClick={() => {
                setSelected(null);
                load().catch((e) => setError(e.message));
              }}
            >
              ← 全部知识库
            </button>
            <button className="text-button" onClick={startCreate}>
              新建知识库
            </button>
          </div>
          <section className="library-description">
            <header>
              <h2>{selected.name}</h2>
              <div className="library-description-actions">
                <button
                  className="text-button"
                  onClick={() => setForm({ ...selected, isNew: false })}
                >
                  编辑说明
                </button>
                <button className="text-button library-delete-button" disabled={busy} onClick={() => prepareDelete(selected.name)}>删除知识库</button>
              </div>
            </header>
            <p>{selected.description || "尚未填写收录说明"}</p>
            <p>
              <b>使用场景：</b>
              {selected.whenToUse || "请补充什么时候使用此库"}
            </p>
            {selected.limitations && (
              <p>
                <b>注意事项：</b>
                {selected.limitations}
              </p>
            )}
          </section>
          <EducationTools
            onCreated={(message) => { setNotice(message); setMaterialsVersion((v) => v + 1); }}
            onProposed={(message) => { setNotice(message); }}
            onError={(message) => setError(message)}
          />
          <KnowledgeView
            key={`${selected.name}-${materialsVersion}`}
            collection={selected.name}
            onOpenTask={onOpenTask}
          />
        </>
      ) : (
        <>
          <p className="muted">
            先写清用途，再上传资料。助手可以读取各库说明，并在指定库内查找带出处的原文。若配置云端嵌入，索引文本将发送给配置的服务；离线使用可选择本地嵌入或关键词检索。
          </p>
          <div className="library-grid">
            {libraries.map((item) => (
              <article className="module-card library-card" key={item.name}>
                <h2>{item.name}</h2>
                <p>{item.description || "待补充：这个知识库收录什么资料？"}</p>
                <p>
                  <b>什么时候用</b>
                  <br />
                  {item.whenToUse || "尚未填写使用场景"}
                </p>
                <small>
                  {item.documentCount} 份资料
                  {item.needsDescription ? " · 用途说明待补充" : ""}
                </small>
                <div className="toolbar-actions">
                  <button
                    className="secondary"
                    onClick={() => setSelected(item)}
                  >
                    打开知识库
                  </button>
                  <button
                    className="text-button"
                    onClick={() => setForm({ ...item, isNew: false })}
                  >
                    编辑说明
                  </button>
                  <button className="text-button library-delete-button" disabled={busy} onClick={() => prepareDelete(item.name)}>删除知识库</button>
                </div>
              </article>
            ))}
          </div>
          {loading && <p role="status">正在读取知识库…</p>}
          {!loading && !error && !libraries.length && (
            <p className="module-card">
              还没有知识库。先创建一个，例如“科室随访规范”，然后上传资料。
            </p>
          )}
        </>
      )}
    </div>
  );
}
