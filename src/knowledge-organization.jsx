import { useEffect, useRef, useState } from "react";
import { api } from "./agent-runtime";
const accept =
  ".pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx,.txt,.md,.markdown,.csv,.tsv,.json,.mp3,.m4a,.wav,.mp4,.mov,.srt,.vtt";
export const timeLabel = (value) =>
  [
    Math.floor(value / 3600),
    Math.floor(value / 60) % 60,
    Math.floor(value) % 60,
  ]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
const statuses = {
  queued: "等待处理",
  running: "整理中",
  needs_input: "需要配置",
  failed: "未完成",
  interrupted: "已中断",
  completed: "整理完成",
  cancelled: "已停止",
};
export function KnowledgeOrganization({ collection, docs, onRefresh, onRead }) {
  const [data, setData] = useState({ jobs: [] }),
    [error, setError] = useState(""),
    [uploading, setUploading] = useState(""),
    [kind, setKind] = useState("资料"),
    [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState({
    baseUrl: "",
    model: "whisper-1",
    apiKey: "",
  });
  const [saving, setSaving] = useState(false),
    [notice, setNotice] = useState("");
  const fileRef = useRef(),
    signatures = useRef("");
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const value = await api(
          "/api/knowledge/organization?" + new URLSearchParams({ collection }),
        );
        if (!alive) return;
        setData(value);
        const signature = JSON.stringify(
          value.jobs.map((j) => [j.id, j.status, j.docId, j.batchDone]),
        );
        if (signatures.current !== signature) {
          signatures.current = signature;
          refreshRef.current?.();
        }
      } catch (e) {
        if (alive) setError(e.message);
      }
    };
    load();
    const timer = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [collection]);
  const perform = async (fn) => {
    setError("");
    try {
      await fn();
      const value = await api(
        "/api/knowledge/organization?" + new URLSearchParams({ collection }),
      );
      setData(value);
      await onRefresh?.();
    } catch (e) {
      setError(e.message);
    }
  };
  const upload = async (event) => {
    const files = [...event.target.files];
    event.target.value = "";
    if (!files.length) return;
    setError("");
    setNotice("");
    const failures = [];
    let duplicate = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setUploading(`正在上传 ${i + 1}/${files.length}：${file.name}`);
      try {
        const job = await api(
          "/api/knowledge/organization?" +
            new URLSearchParams({
              collection,
              name: file.name,
              sourceKind: kind,
            }),
          {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "X-Knowledge-Consent": "true",
            },
            body: file,
          },
        );
        if (job.duplicate) duplicate++;
      } catch (e) {
        failures.push(file.name + "：" + e.message);
      }
    }
    setUploading("");
    setError(failures.join("；"));
    setNotice(
      `已提交 ${files.length - failures.length} 份资料${duplicate ? `，其中 ${duplicate} 份已存在，未重复导入` : ""}。上传完成的资料会在后台整理，可以离开本页。`,
    );
    await perform(async () => {});
  };
  const start = (doc) =>
    perform(() =>
      api(`/api/knowledge/${doc.id}/organization`, "POST", {
        externalConsent: true,
        sourceKind: kind,
      }),
    );
  const unfinished = data.jobs.filter((j) => j.status !== "completed");
  const unorganized = docs.filter(
    (d) =>
      d.reviewStatus !== "retired" && !data.jobs.some((j) => j.docId === d.id),
  );
  return (
    <section className="knowledge-auto" aria-label="自动整理资料">
      <div className="knowledge-auto-head">
        <div>
          <h3>添加资料，自动整理</h3>
          <p>
            支持文档、图片、录音、视频和字幕。上传完成后可离开本页，处理进度会保存。
          </p>
        </div>
        <button
          className="primary"
          disabled={!collection || Boolean(uploading)}
          onClick={() => fileRef.current.click()}
        >
          添加资料并自动整理
        </button>
      </div>
      <input
        ref={fileRef}
        aria-label="自动整理上传文件"
        type="file"
        multiple
        accept={accept}
        hidden
        onChange={upload}
      />
      <div className="knowledge-auto-options">
        <label>
          资料性质{" "}
          <select
            aria-label="上传资料性质"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            {["资料", "指南/共识", "课程/讲座", "病例报告", "笔记/经验"].map(
              (k) => (
                <option key={k}>{k}</option>
              ),
            )}
          </select>
        </label>
        <button
          className="text-button"
          onClick={() => {
            setShowSettings(!showSettings);
            setSettings({
              baseUrl: data.transcription?.baseUrl || "",
              model: data.transcription?.model || "whisper-1",
              apiKey: "",
            });
          }}
        >
          转写服务{data.transcriptionReady ? "：已配置" : "：未配置"}
        </button>
      </div>
      <p className="knowledge-processing-note">
        整理内容交由当前聊天模型处理；音频交由您配置的转写服务处理。原件保存在本机。文档/图片单份不超过
        20MB，音视频不超过 250MB、2 小时。
      </p>
      {!data.modelReady && (
        <p className="knowledge-inline-warning">
          整理模型尚未配置。资料可先保存，配置后点击“继续整理”。
        </p>
      )}
      {showSettings && (
        <form
          className="knowledge-media-settings"
          onSubmit={async (e) => {
            e.preventDefault();
            setSaving(true);
            await perform(async () => {
              const local = /^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(
                settings.baseUrl,
              );
              const value = await api(
                "/api/knowledge/transcription-settings",
                "PUT",
                {
                  provider: local ? "local" : "openai-compatible",
                  baseUrl: settings.baseUrl,
                  model: settings.model,
                  ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
                },
              );
              setData((previous) => ({ ...previous, ...value }));
              setNotice(
                "转写连接已保存，尚未验证实际转写。可上传一段录音测试。",
              );
              setSettings((previous) => ({ ...previous, apiKey: "" }));
            });
            setSaving(false);
          }}
        >
          <h4>音频转写连接</h4>
          <p>
            使用兼容 audio/transcriptions
            的服务。普通聊天模型不一定支持转写。whisper-1
            可提供句段时间点；其他模型若只返回文字，会保留分段范围。
          </p>
          <label>
            接口地址
            <input
              required
              type="url"
              aria-label="转写接口地址"
              placeholder="https://您的服务地址/v1 或本机地址"
              value={settings.baseUrl}
              onChange={(e) =>
                setSettings({ ...settings, baseUrl: e.target.value })
              }
            />
          </label>
          <label>
            转写模型
            <input
              required
              aria-label="转写模型"
              value={settings.model}
              onChange={(e) =>
                setSettings({ ...settings, model: e.target.value })
              }
            />
          </label>
          <label>
            API Key
            <input
              type="password"
              autoComplete="new-password"
              aria-label="转写 API Key"
              placeholder={
                data.transcription?.hasKey
                  ? "已保存，留空保持原密钥"
                  : "本机无密钥服务可留空"
              }
              value={settings.apiKey}
              onChange={(e) =>
                setSettings({ ...settings, apiKey: e.target.value })
              }
            />
          </label>
          <button className="secondary" disabled={saving}>
            {saving ? "保存中…" : "保存转写连接"}
          </button>
        </form>
      )}
      {uploading && <p role="status">{uploading}</p>}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {!!unfinished.length && (
        <div className="knowledge-jobs" aria-label="后台整理进度">
          {unfinished.map((job) => (
            <article key={job.id}>
              <div>
                <strong>{job.fileName}</strong>
                <span>{statuses[job.status]}</span>
              </div>
              <p>
                {job.stage}
                {job.batchTotal
                  ? ` · ${job.batchDone}/${job.batchTotal} 批`
                  : ""}
              </p>
              {job.error && <p className="form-error">{job.error}</p>}
              <div className="toolbar-actions">
                {["failed", "interrupted", "needs_input", "cancelled"].includes(
                  job.status,
                ) && (
                  <button
                    className="secondary"
                    onClick={() =>
                      perform(() =>
                        api(
                          `/api/knowledge/organization/${job.id}/retry`,
                          "POST",
                          { externalConsent: true },
                        ),
                      )
                    }
                  >
                    继续整理
                  </button>
                )}
                {job.status !== "cancelled" && (
                  <button
                    className="text-button"
                    onClick={() =>
                      perform(() =>
                        api(
                          `/api/knowledge/organization/${job.id}/cancel`,
                          "POST",
                          {},
                        ),
                      )
                    }
                  >
                    停止整理
                  </button>
                )}
                {!job.docId && !["running", "queued"].includes(job.status) && (
                  <button
                    className="text-button"
                    onClick={() => {
                      if (window.confirm("删除这份未入库资料及其原文件？"))
                        perform(() =>
                          api(
                            `/api/knowledge/organization/${job.id}`,
                            "DELETE",
                          ),
                        );
                    }}
                  >
                    删除此资料
                  </button>
                )}
                {job.docId && (
                  <button
                    className="text-button"
                    onClick={() => onRead(job.docId)}
                  >
                    查看已保存文字
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {!!unorganized.length && (
        <details className="knowledge-existing">
          <summary>已有 {unorganized.length} 份资料尚未生成知识地图</summary>
          <p>
            保留原文和文档信息，仅增加待核对的知识条目。使用上方所选资料性质和当前聊天模型。
          </p>
          <button
            className="secondary"
            onClick={() =>
              perform(async () => {
                for (const doc of unorganized)
                  await api(`/api/knowledge/${doc.id}/organization`, "POST", {
                    externalConsent: true,
                    sourceKind: kind,
                  });
              })
            }
          >
            整理这些资料
          </button>
          {unorganized.map((doc) => (
            <div key={doc.id}>
              <span>{doc.title}</span>
              <button className="text-button" onClick={() => start(doc)}>
                整理此资料
              </button>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
export function KnowledgeMap({ collection, onRead, onAsk, refreshKey }) {
  const [graph, setGraph] = useState({ nodes: [], edges: [] }),
    [query, setQuery] = useState(""),
    [type, setType] = useState(""),
    [selected, setSelected] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    api("/api/knowledge/map?" + new URLSearchParams({ collection }))
      .then((value) => {
        if (alive) setGraph(value);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [collection, refreshKey]);
  const filtered = graph.nodes.filter(
    (n) =>
      (!type || n.type === type) &&
      (!query || n.label.toLowerCase().includes(query.toLowerCase())),
  );
  const chosen = graph.nodes.find((n) => n.id === selected);
  const related = chosen
    ? new Set(
        graph.edges
          .filter((e) => e.from === selected || e.to === selected)
          .flatMap((e) => [e.from, e.to]),
      )
    : null;
  const visible = (
    related && !query && !type
      ? filtered.filter((n) => related.has(n.id))
      : filtered
  ).slice(0, 18);
  if (chosen && !visible.some((n) => n.id === chosen.id) && !query && !type)
    visible.unshift(chosen);
  const positioned = visible.map((n, i) => ({
    ...n,
    x:
      400 +
      290 *
        Math.cos((i * 2 * Math.PI) / Math.max(visible.length, 1) - Math.PI / 2),
    y:
      240 +
      175 *
        Math.sin((i * 2 * Math.PI) / Math.max(visible.length, 1) - Math.PI / 2),
  }));
  const edges = graph.edges.filter(
    (e) =>
      positioned.some((n) => n.id === e.from) &&
      positioned.some((n) => n.id === e.to),
  );
  return (
    <section className="knowledge-map" aria-label="知识地图">
      <div className="knowledge-map-intro">
        <h3>从主题找到依据</h3>
        <p>
          {graph.analyzedDocuments || 0}/{graph.documentCount || 0} 份资料已整理
          · {graph.nodes.length} 个知识点。关系由模型根据原文整理，均待核对。
        </p>
      </div>
      <div className="knowledge-map-filters">
        <input
          aria-label="搜索知识点"
          placeholder="查找疾病、药物或主题"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected("");
          }}
        />
        <select
          aria-label="知识点类型"
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            setSelected("");
          }}
        >
          <option value="">全部主题</option>
          {["疾病", "阶段", "检查", "治疗", "药物", "随访", "主题"].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        {selected && (
          <button className="text-button" onClick={() => setSelected("")}>
            返回全图
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {!graph.nodes.length ? (
        <div className="knowledge-map-empty">
          <h4>知识地图还在等待资料</h4>
          <p>
            添加资料自动整理，或展开上方“已有资料”生成知识条目。没有出处的关系不会显示在图中。
          </p>
        </div>
      ) : (
        <div className="knowledge-map-layout">
          <div>
            <svg viewBox="0 0 800 480" role="group" aria-label="知识关系图">
              {edges.map((e) => {
                const a = positioned.find((n) => n.id === e.from),
                  b = positioned.find((n) => n.id === e.to);
                return (
                  <line
                    key={e.id}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    className={
                      selected && (e.from === selected || e.to === selected)
                        ? "active"
                        : ""
                    }
                  />
                );
              })}
              {positioned.map((n) => (
                <g
                  key={n.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`知识点：${n.label}`}
                  className={n.id === selected ? "selected" : ""}
                  onClick={() => setSelected(n.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelected(n.id);
                    }
                  }}
                >
                  <title>
                    {n.label} · {n.type}
                  </title>
                  <circle cx={n.x} cy={n.y} r={n.id === selected ? 27 : 22} />
                  <text x={n.x} y={n.y + 5} className="node-type">
                    {n.type}
                  </text>
                  <text x={n.x} y={n.y + 47}>
                    {n.label.length > 16 ? n.label.slice(0, 15) + "…" : n.label}
                  </text>
                </g>
              ))}
            </svg>
            <p className="muted">
              每次展示最多 18 个主题，点击节点查看关联和原文；也可搜索定位。
            </p>
            {!visible.length && <p>没有匹配的知识点。</p>}
          </div>
          <aside className="knowledge-map-evidence">
            {chosen ? (
              <>
                <h3>{chosen.label}</h3>
                <p>{chosen.type} · 来源关系待核对</p>
                {onAsk && (
                  <button className="secondary" onClick={() => onAsk(chosen)}>
                    围绕这个主题提问
                  </button>
                )}
                {graph.edges
                  .filter((e) => e.from === chosen.id || e.to === chosen.id)
                  .map((e) => (
                    <article key={e.id}>
                      <strong>
                        {graph.nodes.find((n) => n.id === e.from)?.label} →{" "}
                        {e.relation} →{" "}
                        {graph.nodes.find((n) => n.id === e.to)?.label}
                      </strong>
                      <blockquote>{e.quote}</blockquote>
                      <p>
                        {e.sourceKind} · {e.docTitle}
                      </p>
                      <button
                        className="text-button"
                        onClick={() =>
                          onRead(e.docId, {
                            startLine: e.startLine,
                            endLine: e.endLine,
                          })
                        }
                      >
                        查看依据 · 第 {e.startLine}–{e.endLine} 行
                      </button>
                    </article>
                  ))}
                <h4>提到此主题的资料</h4>
                {chosen.evidence.map((ev, i) => (
                  <article key={i}>
                    <blockquote>{ev.quote}</blockquote>
                    <p>
                      {ev.sourceKind} · {ev.docTitle}
                    </p>
                    <button
                      className="text-button"
                      onClick={() =>
                        onRead(ev.docId, {
                          startLine: ev.startLine,
                          endLine: ev.endLine,
                        })
                      }
                    >
                      查看原文
                    </button>
                  </article>
                ))}
              </>
            ) : (
              <>
                <h3>点击一个知识点</h3>
                <p>
                  在这里查看相关关系、原文依据和资料类型。不同来源的说法分别保留，不自动合并成诊疗结论。
                </p>
              </>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
export function KnowledgeReading({ doc, highlight }) {
  const [detail, setDetail] = useState(null),
    [playback, setPlayback] = useState(null),
    [error, setError] = useState("");
  const media = useRef();
  useEffect(() => {
    let alive = true;
    setDetail(null);
    setPlayback(null);
    api(`/api/knowledge/${doc.id}/organization`)
      .then((v) => {
        if (alive) setDetail(v);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [doc.id]);
  const locator = detail?.locators.find(
    (l) =>
      l.startLine <= (highlight?.startLine || 1) &&
      l.endLine >= (highlight?.startLine || 1),
  );
  useEffect(() => {
    if (media.current && Number.isFinite(locator?.start))
      media.current.currentTime = locator.start;
  }, [locator?.start]);
  const seek = () => {
    if (media.current && Number.isFinite(locator?.start))
      media.current.currentTime = locator.start;
  };
  return (
    <div className="knowledge-reading-extra">
      {error && <p role="alert">{error}</p>}
      {detail?.job && (
        <p className="muted">
          资料性质：{detail.job.sourceKind} · {statuses[detail.job.status]}
          {detail.job.mediaInfo?.hasVideo
            ? " · 视频每 30 秒抽样画面，不能替代完整观看"
            : ""}
        </p>
      )}
      {detail?.job?.hasOriginal && !playback && (
        <button
          className="secondary"
          onClick={async () => {
            try {
              setPlayback(
                await api(
                  `/api/knowledge/organization/${detail.job.id}/playback`,
                  "POST",
                  {},
                ),
              );
            } catch (e) {
              setError(e.message);
            }
          }}
        >
          打开原文件
          {Number.isFinite(locator?.start)
            ? " · " + timeLabel(locator.start)
            : ""}
        </button>
      )}
      {playback &&
        (playback.media ? (
          <div className="knowledge-player">
            {playback.video ? (
              <video
                ref={media}
                controls
                src={playback.url}
                onLoadedMetadata={seek}
              />
            ) : (
              <audio
                ref={media}
                controls
                src={playback.url}
                onLoadedMetadata={seek}
              />
            )}
            <p>
              {Number.isFinite(locator?.start)
                ? `原文对应 ${timeLabel(locator.start)}${locator.timing === "chunk" ? " 起的音频分段（非句子精确时间）" : ""}`
                : "可按下方时间标记查找对应内容"}
            </p>
          </div>
        ) : (
          <a href={playback.url} target="_blank" rel="noreferrer">
            查看或下载原文件
          </a>
        ))}
      {!!detail?.analysis?.batches?.length && (
        <details className="knowledge-outline">
          <summary>整理摘要与章节 · 待核对</summary>
          {detail.analysis.batches.filter(Boolean).map((b, i) => (
            <article key={i}>
              <h4>{b.title}</h4>
              <p>{b.summary}</p>
              <button
                className="text-button"
                onClick={() =>
                  document
                    .querySelector(`[data-line="${b.startLine}"]`)
                    ?.scrollIntoView({ block: "center" })
                }
              >
                查看本节原文 · 第 {b.startLine}–{b.endLine} 行
              </button>
            </article>
          ))}
        </details>
      )}
    </div>
  );
}
