import { useEffect, useRef, useState } from "react";
import { Play, Square, Terminal } from "lucide-react";
import { api } from "../agent-runtime";
export function TerminalPanel({ current, running, onSettings }) {
  const [sessions, setSessions] = useState([]),
    [active, setActive] = useState(null),
    [command, setCommand] = useState(""),
    [input, setInput] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const output = useRef(null),
    follow = useRef(true);
  const base = `/api/workspaces/${current.id}`;
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const data = await api(base + "/extensions");
        if (alive) setSessions(data.terminals || []);
      } catch (e) {
        if (alive) setError(e.message);
      }
    }
    load();
    const timer = setInterval(load, 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [base]);
  const session = sessions.find((s) => s.id === active) || sessions.at(-1);
  useEffect(() => {
    if (follow.current && output.current)
      output.current.scrollTop = output.current.scrollHeight;
  }, [session?.output]);
  async function invoke(tool, args) {
    if (busy || running) return false;
    setBusy(true);
    setError("");
    try {
      const data = await api(base + "/tools", "POST", {
        tool,
        arguments: args,
      });
      setActive(data.id);
      setSessions((old) => [...old.filter((s) => s.id !== data.id), data]);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="wb-terminal">
      <header>
        <Terminal size={15} />
        <b>终端</b>
        <span>隔离项目快照</span>
      </header>
      {!current.permissions.grants["process.spawn"] ? (
        <div className="wb-terminal-empty">
          <p>启用运行环境后，可以在这里执行命令、查看持续输出并输入文本。</p>
          <button onClick={onSettings}>配置运行环境</button>
        </div>
      ) : (
        <>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await invoke("terminal_start", {
                  command,
                  snapshot: true,
                  timeoutMs: 300000,
                })
              )
                setCommand("");
            }}
          >
            <span>$</span>
            <input
              aria-label="终端命令"
              placeholder="输入命令，例如 npm test"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
            <button
              disabled={busy || running || !command.trim()}
              aria-label="运行命令"
            >
              <Play size={14} />
            </button>
          </form>
          {sessions.length > 0 && (
            <nav aria-label="终端会话">
              {sessions.map((s, i) => (
                <button
                  className={session?.id === s.id ? "selected" : ""}
                  key={s.id}
                  onClick={() => setActive(s.id)}
                >
                  终端 {i + 1} ·{" "}
                  {s.status === "running"
                    ? "运行中"
                    : `退出 ${s.exitCode ?? "—"}`}
                </button>
              ))}
            </nav>
          )}
          <pre
            ref={output}
            onScroll={(e) => {
              const el = e.currentTarget;
              follow.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 50;
            }}
            className="wb-terminal-output"
            aria-live="off"
          >
            {session?.output || "命令输出将显示在这里。"}
            {session?.error && `\n${session.error}`}
          </pre>
          {session?.status === "running" && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await invoke("terminal_write", {
                    id: session.id,
                    input: input + "\n",
                  })
                )
                  setInput("");
              }}
            >
              <input
                aria-label="终端标准输入"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="向进程发送输入"
              />
              <button disabled={busy || running}>发送</button>
              <button
                type="button"
                disabled={busy || running}
                onClick={() => invoke("terminal_stop", { id: session.id })}
              >
                <Square size={12} />
                停止
              </button>
            </form>
          )}
          {running && (
            <p className="wb-muted">
              Agent 正在使用工作区；可以查看输出，手动命令将在任务结束后可用。
            </p>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
