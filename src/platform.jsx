import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { bootstrap } from "./agent-runtime";
import { ModelSettings } from "./model-settings";
import { WorkspacesView } from "./workspaces";
import "./style.css";

function Platform() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [config, setConfig] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    bootstrap()
      .then(setConfig)
      .catch((e) => setError(e.message));
  }, []);
  if (error)
    return (
      <main>
        <p role="alert">{error}</p>
      </main>
    );
  if (!config) return <main>正在连接本地运行时…</main>;
  return (
    <>
      <header className="workspace-heading">
        <div>
          <h1>Open Agent</h1>
          <span className="workspace-heading-kicker">LOCAL WORKSPACE</span>
        </div>
        <p>
          {config.modelConfigured
            ? `${config.provider} · ${config.model}`
            : "配置 .env 模型后可执行 Agent 任务；文件与审批可离线使用。"}
        </p>
      </header>
      {!config.modelConfigured && <div className="model-connect-banner"><span>连接模型后即可开始任务</span><button onClick={() => setSettingsOpen(true)}>配置模型</button></div>}
      {settingsOpen && <ModelSettings onClose={() => setSettingsOpen(false)} onSaved={async () => setConfig(await bootstrap(true))} />}
      <WorkspacesView config={config} onOpenSettings={() => setSettingsOpen(true)} />
    </>
  );
}
createRoot(document.getElementById("root")).render(<Platform />);
