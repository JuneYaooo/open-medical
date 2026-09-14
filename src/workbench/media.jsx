import { useEffect, useState } from "react";
import { api } from "../agent-runtime";
import { LiveMedia } from "./live-media";
export function MediaPanel({ current, refresh, running, onSettings }) {
  const [profiles, setProfiles] = useState([]),
    [profile, setProfile] = useState(""),
    [action, setAction] = useState("image"),
    [text, setText] = useState(""),
    [voice, setVoice] = useState("alloy"),
    [artifact, setArtifact] = useState(""),
    [consent, setConsent] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState(null);
  const base = `/api/workspaces/${current.id}`;
  useEffect(() => {
    let alive = true;
    api("/api/model-profiles")
      .then((d) => {
        if (alive)
          setProfiles(
            d.profiles.filter((p) => (current.teamModels || []).includes(p.id)),
          );
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [current.id, current.teamModels]);
  async function upload(file) {
    if (!file) return;
    if (file.size > 10000000) {
      setError("音视频最多 10MB");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const item = await api(
        `${base}/upload-media?name=${encodeURIComponent(file.name)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: file,
        },
      );
      setArtifact(item.id);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function generate() {
    setBusy(true);
    setError("");
    try {
      setResult(
        await api(base + "/media", "POST", {
          action,
          modelProfile: profile,
          text,
          voice,
          artifactId: artifact,
          consent,
        }),
      );
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h3>图片与音视频</h3>
      <p>
        使用你配置的兼容媒体接口。模型需要支持所选功能；生成结果存入当前任务成果。
      </p>
      {!profiles.length && (
        <button onClick={onSettings}>添加并授权媒体模型连接</button>
      )}
      <fieldset disabled={busy || running}>
        <label>
          媒体连接
          <select
            value={profile}
            onChange={(e) => {
              setProfile(e.target.value);
              setConsent(false);
            }}
          >
            <option value="">选择已授权连接</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} · {p.model}
              </option>
            ))}
          </select>
        </label>
        <label>
          操作
          <select
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setConsent(false);
            }}
          >
            <option value="image">生成图片</option>
            <option value="transcribe">音视频转文字</option>
            <option value="speech">文字转 AI 语音</option>
          </select>
        </label>
        {action === "transcribe" ? (
          <>
            <label>
              上传音视频
              <input
                type="file"
                accept=".mp3,.mp4,.m4a,.wav,.webm,.ogg,.flac"
                onChange={(e) => upload(e.target.files[0])}
              />
            </label>
            <label>
              待转写文件
              <select
                value={artifact}
                onChange={(e) => setArtifact(e.target.value)}
              >
                <option value="">选择文件</option>
                {current.artifacts
                  ?.filter((a) =>
                    /\.(mp3|mp4|m4a|wav|webm|ogg|flac)$/i.test(a.name),
                  )
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </label>
          </>
        ) : (
          <label>
            {action === "image" ? "图片描述" : "朗读文本"}
            <textarea value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        )}
        {action === "speech" && (
          <label>
            预设音色
            <input value={voice} onChange={(e) => setVoice(e.target.value)} />
          </label>
        )}
        <label className="workspace-checkbox">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          授权将上述文本或所选音视频发送给此媒体服务，可能产生 API 费用
        </label>
        <button
          disabled={
            !consent ||
            !profile ||
            (action === "transcribe" ? !artifact : !text.trim())
          }
          onClick={generate}
        >
          开始处理
        </button>
      </fieldset>
      {busy && (
        <>
          <p role="status">正在处理，最长等待两分钟…</p>
          <button
            onClick={() =>
              api(base + "/media", "DELETE").catch((e) => setError(e.message))
            }
          >
            停止媒体请求
          </button>
        </>
      )}
      {result && (
        <p>已生成 {result.artifact.name}，可在对话成果区预览或下载。</p>
      )}
      {error && <p role="alert">{error}</p>}
      <LiveMedia
        current={current}
        profile={profile}
        consent={consent}
        refresh={refresh}
      />
    </section>
  );
}
