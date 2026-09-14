import { useEffect, useRef, useState } from "react";
import { api } from "../agent-runtime";

export function LiveMedia({ current, profile, consent, refresh }) {
  const [workspaceReadConsent, setWorkspaceReadConsent] = useState(false),
    [jobs, setJobs] = useState([]),
    [prompt, setPrompt] = useState(""),
    [seconds, setSeconds] = useState("4"),
    [status, setStatus] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const session = useRef(null),
    audio = useRef(null),
    video = useRef(null);
  const base = `/api/workspaces/${current.id}`;
  const reload = () => api(base + "/videos").then((d) => setJobs(d.jobs));
  function stop() {
    const active = session.current;
    session.current = null;
    if (active?.sessionId)
      void api(base + "/realtime", "DELETE", {
        sessionId: active.sessionId,
      }).catch(() => {});
    if (active) {
      clearInterval(active.timer);
      clearTimeout(active.timeout);
      active.pc?.close();
      active.stream?.getTracks().forEach((t) => t.stop());
      active.display?.getTracks().forEach((t) => t.stop());
    }
    if (audio.current) audio.current.srcObject = null;
    if (video.current) video.current.srcObject = null;
    setStatus("");
  }
  useEffect(() => {
    let alive = true;
    api(base + "/videos")
      .then((d) => {
        if (alive) setJobs(d.jobs);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
      stop();
    };
  }, [base, profile, consent, JSON.stringify(current.teamModels)]);
  async function action(input) {
    setBusy(true);
    setError("");
    try {
      await api(base + "/videos", "POST", input);
      await reload();
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function connect() {
    setError("");
    setStatus("正在连接…");
    const active = { pc: new RTCPeerConnection() };
    session.current = active;
    try {
      active.stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      if (session.current !== active) {
        active.stream.getTracks().forEach((t) => t.stop());
        return;
      }
      active.stream
        .getTracks()
        .forEach((t) => active.pc.addTrack(t, active.stream));
      active.pc.ontrack = (e) => {
        if (audio.current) {
          audio.current.srcObject = e.streams[0];
          audio.current
            .play()
            .catch(() => setError("请点击音频播放器开始播放"));
        }
      };
      active.pc.onconnectionstatechange = () => {
        if (
          ["failed", "disconnected", "closed"].includes(
            active.pc.connectionState,
          ) &&
          session.current === active
        )
          stop();
      };
      active.channel = active.pc.createDataChannel("oai-events");
      active.channel.onmessage = async (e) => {
        try {
          const data = JSON.parse(e.data);
          if (
            data.type === "response.function_call_arguments.done" &&
            active.sessionId &&
            active.channel.readyState === "open"
          ) {
            let output;
            try {
              output = await api(base + "/realtime-tool", "POST", {
                sessionId: active.sessionId,
                tool: data.name,
                arguments: JSON.parse(data.arguments),
              });
            } catch (error) {
              output = { error: error.message };
            }
            if (
              session.current === active &&
              active.channel.readyState === "open"
            ) {
              active.channel.send(
                JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: data.call_id,
                    output: JSON.stringify(output),
                  },
                }),
              );
              active.channel.send(JSON.stringify({ type: "response.create" }));
            }
          }
          if (data.type === "error")
            setError(data.error?.message || "实时服务错误");
          if (
            data.type === "response.output_audio_transcript.done" ||
            data.type === "response.audio_transcript.done"
          )
            setStatus(data.transcript);
        } catch {}
      };
      await active.pc.setLocalDescription(await active.pc.createOffer());
      const result = await api(base + "/realtime", "POST", {
        modelProfile: profile,
        consent,
        workspaceReadConsent,
        sdp: active.pc.localDescription.sdp,
      });
      active.sessionId = result.sessionId;
      if (session.current !== active) {
        void api(base + "/realtime", "DELETE", {
          sessionId: result.sessionId,
        }).catch(() => {});
        return;
      }
      await active.pc.setRemoteDescription({ type: "answer", sdp: result.sdp });
      setStatus("通话中 · 正在使用麦克风");
      active.timeout = setTimeout(stop, 30 * 60 * 1000);
    } catch (e) {
      stop();
      setError(e.message);
    }
  }
  async function share(camera = false) {
    const active = session.current;
    if (!active) return;
    try {
      const display = camera
        ? await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false,
          })
        : await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: false,
          });
      if (session.current !== active) {
        display.getTracks().forEach((t) => t.stop());
        return;
      }
      active.display?.getTracks().forEach((t) => t.stop());
      clearInterval(active.timer);
      active.display = display;
      video.current.srcObject = display;
      await video.current.play();
      const canvas = document.createElement("canvas");
      active.timer = setInterval(() => {
        if (
          !video.current?.videoWidth ||
          active.channel.readyState !== "open" ||
          active.channel.bufferedAmount > 1_000_000
        )
          return;
        canvas.width = Math.min(960, video.current.videoWidth);
        canvas.height = Math.round(
          (canvas.width * video.current.videoHeight) / video.current.videoWidth,
        );
        canvas
          .getContext("2d")
          .drawImage(video.current, 0, 0, canvas.width, canvas.height);
        active.channel.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_image",
                  image_url: canvas.toDataURL("image/jpeg", 0.6),
                },
              ],
            },
          }),
        );
      }, 5000);
      display.getVideoTracks()[0].onended = () => {
        clearInterval(active.timer);
        if (video.current) video.current.srcObject = null;
      };
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <section>
      <h3>实时语音与共享画面</h3>
      <p>
        使用上方已授权的实时模型连接。共享画面每五秒发送一帧，麦克风持续传输；最长三十分钟，可随时结束。
      </p>
      <label>
        <input
          type="checkbox"
          checked={workspaceReadConsent}
          disabled={!!status}
          onChange={(e) => setWorkspaceReadConsent(e.target.checked)}
        />
        允许语音模型查询当前项目文件
      </label>
      <button disabled={!consent || !profile || !!status} onClick={connect}>
        开始语音通话
      </button>
      <button disabled={!session.current} onClick={() => share(false)}>
        共享画面
      </button>
      <button disabled={!session.current} onClick={() => share(true)}>
        共享摄像头
      </button>
      <button disabled={!session.current} onClick={stop}>
        结束通话与共享
      </button>
      <audio ref={audio} controls autoPlay />
      <video ref={video} muted playsInline style={{ maxWidth: "100%" }} />
      {status && <p role="status">{status}</p>}
      <h3>视频生成任务</h3>
      <p>
        使用兼容 videos API 的连接。提交后保留任务
        ID，关闭页面后可继续查询。单个视频下载上限 100MB。
      </p>
      <textarea
        aria-label="视频描述"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <select
        aria-label="视频时长"
        value={seconds}
        onChange={(e) => setSeconds(e.target.value)}
      >
        {[4, 8, 12].map((n) => (
          <option key={n} value={n}>
            {n} 秒
          </option>
        ))}
      </select>
      <button
        disabled={!consent || !profile || !prompt.trim() || busy}
        onClick={() =>
          action({
            action: "create",
            text: prompt,
            seconds,
            modelProfile: profile,
            consent,
          })
        }
      >
        生成视频
      </button>
      {jobs.map((job) => (
        <article key={job.id}>
          <p>
            {job.remoteId || job.id} · {job.status}{" "}
            {job.progress != null ? `${job.progress}%` : ""}
          </p>
          {job.error && <p>{job.error}</p>}
          <button
            disabled={!job.remoteId || busy}
            onClick={() => action({ action: "refresh", jobId: job.id })}
          >
            查询进度
          </button>
          <button
            disabled={job.status !== "completed" || busy || !!job.artifact}
            onClick={() => action({ action: "download", jobId: job.id })}
          >
            {job.artifact ? "已保存到成果" : "保存视频成果"}
          </button>
        </article>
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
