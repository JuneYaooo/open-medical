import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../agent-runtime";
export function InteractiveTerminal({ current, disabled }) {
  const host = useRef(null),
    [session, setSession] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [consent, setConsent] = useState(false),
    [previewPort,setPreviewPort] = useState("");
  const base = `/api/workspaces/${current.id}/pty`;
  useEffect(() => {
    let alive = true;
    api(base)
      .then((d) => {
        if (alive)
          setSession(d.sessions.find((s) => s.status === "running") || null);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [base]);
  useEffect(() => {
    if (!session?.id) return;
    let alive = true,
      cursor = 0,
      timer,
      sendTimer,
      pending = "",
      queue = Promise.resolve();
    const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 12,
        theme: { background: "#17191b" },
        allowProposedApi: false,
      }),
      fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    const send = (body) => {
      queue = queue
        .then(() => (alive ? api(`${base}/${session.id}`, "POST", body) : null))
        .catch((e) => {
          if (alive) setError(e.message);
        });
    };
    const resize = () => {
      if (!host.current?.clientWidth) return;
      fit.fit();
      if (session.status === "running")
        send({
          action: "resize",
          cols: Math.max(20, Math.min(300, terminal.cols)),
          rows: Math.max(5, Math.min(150, terminal.rows)),
        });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    resize();
    terminal.onData((data) => {
      pending += data;
      clearTimeout(sendTimer);
      sendTimer = setTimeout(() => {
        send({ action: "write", data: pending });
        pending = "";
      }, 25);
    });
    async function read() {
      try {
        const value = await api(`${base}/${session.id}?cursor=${cursor}`);
        if (!alive) return;
        if (value.truncated) terminal.reset();
        if (value.output) terminal.write(value.output);
        cursor = value.cursor;
        setSession(s=>s.previewUrl===value.previewUrl?s:{...s,previewUrl:value.previewUrl});
        if (value.status !== "running") {
          terminal.write(
            `\r\n[进程已退出：${value.exitCode ?? value.status}]\r\n`,
          );
          setSession((s) => ({ ...s, status: value.status }));
          return;
        }
      } catch (e) {
        if (alive) setError(e.message);
      }
      if (alive) timer = setTimeout(read, 300);
    }
    read();
    return () => {
      alive = false;
      clearTimeout(timer);
      clearTimeout(sendTimer);
      observer.disconnect();
      terminal.dispose();
    };
  }, [base, session?.id]);
  return (
    <details>
      <summary>交互终端 · PTY</summary>
      <p>
        在隔离项目快照中运行 shell，支持快捷键和
        ANSI。会话最长一小时，关闭页面后仍运行；退出后容器内修改不会写回项目。
      </p>
      <label className="workspace-checkbox">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
        />
        允许启动隔离交互终端
      </label>
      <label>可选：应用预览端口<input aria-label="应用预览端口" type="number" min="1024" max="65535" placeholder="例如 3000，需开启终端网络" value={previewPort} onChange={e=>setPreviewPort(e.target.value)}/></label>
      {session?.previewUrl && <p><a href={session.previewUrl} target="_blank" rel="noreferrer">打开应用预览</a> · 在终端内启动监听对应端口的服务后打开</p>}
      <button
        disabled={
          disabled ||
          busy ||
          !consent ||
          session?.status === "running" ||
          !current.permissions.grants["process.spawn"]
        }
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            setSession(
              await api(base, "POST", { consent, cols: 100, rows: 28, ...(previewPort ? {previewPort:Number(previewPort)} : {}) }),
            );
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        打开交互终端
      </button>
      {session?.status === "running" && (
        <button
          onClick={async () => {
            try {
              setSession(
                await api(`${base}/${session.id}`, "POST", { action: "stop" }),
              );
            } catch (e) {
              setError(e.message);
            }
          }}
        >
          结束会话
        </button>
      )}
      <div ref={host} aria-label="交互终端" className="wb-pty" />
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
