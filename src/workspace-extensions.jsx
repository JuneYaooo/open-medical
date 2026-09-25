import { useEffect, useState } from "react";
import { api } from "./agent-runtime";

const defaults = {
  terminal: false,
  terminalNetwork: false,
  browser: false,
  plugins: false,
  mcp: false,
  memoryRead: false,
  memoryWrite: false,
  image: "",
  origins: "",
  searchUrl: "",
  braveKey: "",
  memory: { provider: "lsa" },
};
export function WorkspaceExtensionsPanel({ workspace, refresh, disabled, focus = "" }) {
  const base = `/api/workspaces/${workspace.id}`,
    [data, setData] = useState(null),
    [form, setForm] = useState(defaults),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [consent, setConsent] = useState(false);
  const [pluginPath, setPluginPath] = useState(""),
    [inspection, setInspection] = useState(null),
    [authorizationUrl, setAuthorizationUrl] = useState(""),
    [pluginUrl, setPluginUrl] = useState(""),
    [pluginHash, setPluginHash] = useState(""),
    [importText,setImportText]=useState(""), [imported,setImported]=useState([]);
  const [mcpConfig, setMcpConfig] = useState(
    JSON.stringify(
      {
        id: "local-tools",
        transport: "http",
        url: "http://127.0.0.1:3001/mcp",
        allowedTools: [],
        allowResources: false,
      },
      null,
      2,
    ),
  );
  const [command, setCommand] = useState("printf 'Hello from sandbox\\n'"),
    [paths, setPaths] = useState(""),
    [terminal, setTerminal] = useState(null),
    [stdin, setStdin] = useState("");
  const [url, setUrl] = useState(""),
    [page, setPage] = useState(null),
    [screen, setScreen] = useState(null),
    [browserAction, setBrowserAction] = useState("click"),
    [selector, setSelector] = useState(""),
    [value, setValue] = useState("");
  const [note, setNote] = useState(""),
    [memoryPath, setMemoryPath] = useState(""),
    [query, setQuery] = useState(""),
    [matches, setMatches] = useState(null);
  const locked = disabled || busy;
  const authority = JSON.stringify(workspace.permissions.grants);
  useEffect(() => {
    const g = JSON.parse(authority);
    setForm((previous) => ({
      ...previous,
      terminal: g["process.spawn"],
      browser: g["browser.read"],
      plugins: g["plugins.execute"],
      mcp: g["mcp.execute"],
      memoryRead: g["memory.read"],
      memoryWrite: g["memory.write"],
    }));
  }, [authority]);
  async function load(reset = false) {
    const result = await api(base + "/extensions");
    setData(result);
    if (reset) {
      const g = workspace.permissions.grants;
      setForm({
        terminal: g["process.spawn"],
        terminalNetwork: Boolean(result.config.terminalNetwork),
        browser: g["browser.read"],
        plugins: g["plugins.execute"],
        mcp: g["mcp.execute"],
        memoryRead: g["memory.read"],
        memoryWrite: g["memory.write"],
        image: result.config.image || "",
        origins: result.config.origins.join("\n"),
        searchUrl: result.config.searchUrl || "",
        memory: result.config.memory,
      });
    }
    return result;
  }
  useEffect(() => {
    let alive = true;
    api(base + "/extensions")
      .then((result) => {
        if (!alive) return;
        setData(result);
        const g = workspace.permissions.grants;
        setForm({
          terminal: g["process.spawn"],
          terminalNetwork: Boolean(result.config.terminalNetwork),
          browser: g["browser.read"],
          plugins: g["plugins.execute"],
          mcp: g["mcp.execute"],
          memoryRead: g["memory.read"],
          memoryWrite: g["memory.write"],
          image: result.config.image || "",
          origins: result.config.origins.join("\n"),
          searchUrl: result.config.searchUrl || "",
          memory: result.config.memory,
        });
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [base]);
  async function act(fn) {
    if (locked) return;
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh(workspace.id);
      await load();
    } catch (e) {
      setError(e.message);
      await refresh(workspace.id);
    } finally {
      setBusy(false);
    }
  }
  const manage = (body) =>
    api(base + "/extensions", "POST", {
      revision: workspace.revision,
      ...body,
    });
  const tool = (name, args = {}) =>
    api(base + "/tools", "POST", { tool: name, arguments: args });
  return (
    <details className="workspace-files extension-panel" open={focus ? true : undefined}>
      <summary>{focus === "terminal" ? "终端与代码" : focus === "extensions" || focus === "configuration" ? "项目工具与连接" : "工具、插件与记忆"}</summary>
      {error && (
        <p role="alert" className="workspace-error">
          {error}
        </p>
      )}
      {!data ? (
        <p>读取扩展状态…</p>
      ) : (
        <>
          <p className="workspace-note">
            隔离终端：
            {data.sandbox.available ? "Docker 已就绪" : data.sandbox.reason} ·
            浏览器：{data.browser.available ? "已就绪" : data.browser.reason}
          </p>
          <details open={focus ? true : undefined}>
            <summary>授权与运行环境</summary>
            <fieldset disabled={locked}>
              <p>
                单机授权，不涉及用户角色。扩展默认关闭；保存配置会关闭现有工具会话并暂停计划。
              </p>
              <div className="extension-grants">
                {[
                  ["terminal", "隔离终端"],
                  [
                    "terminalNetwork",
                    "允许终端联网（安装依赖及访问容器可达网络）",
                  ],
                  ["browser", "浏览网页（点击与填写逐次审批）"],
                  ["plugins", "已安装插件"],
                  ["mcp", "已授权 MCP 工具"],
                  ["memoryRead", "检索记忆"],
                  ["memoryWrite", "保存与删除记忆"],
                ].map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={Boolean(form[key])}
                      onChange={(e) =>
                        setForm({ ...form, [key]: e.target.checked })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
              <label>
                本地 Docker 镜像（只使用已导入镜像，保存时绑定摘要）
                <input
                  aria-label="沙箱镜像"
                  value={form.image}
                  onChange={(e) => setForm({ ...form, image: e.target.value })}
                  placeholder="例如 open-medical-runtime:0.5-arm64"
                />
              </label>
              <label>
                浏览器允许访问的来源，每行一个
                <textarea
                  aria-label="浏览器授权来源"
                  value={form.origins}
                  onChange={(e) =>
                    setForm({ ...form, origins: e.target.value })
                  }
                  placeholder="https://example.com"
                />
              </label>
              <label>
                SearXNG JSON 搜索地址（可选）
                <input
                  value={form.searchUrl}
                  onChange={(e) =>
                    setForm({ ...form, searchUrl: e.target.value })
                  }
                  placeholder="https://search.example.com/search（来源需在上方授权）"
                />
              </label>
              <label>
                Brave Search API Key（可选，加密存储）
                <input
                  type="password"
                  autoComplete="off"
                  value={form.braveKey}
                  onChange={(e) =>
                    setForm({ ...form, braveKey: e.target.value })
                  }
                  placeholder={
                    data?.config?.braveSearch
                      ? "已保存（留空保持不变，输入新值更换）"
                      : "BSA… 免费层每月 2000 次，brave.com/search/api 申请"
                  }
                />
              </label>
              <label>
                语义记忆后端
                <select
                  value={form.memory.provider}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      memory: {
                        provider: e.target.value,
                        url: "http://127.0.0.1:11434",
                        model: "embeddinggemma",
                      },
                    })
                  }
                >
                  <option value="lsa">内置离线 LSA（无模型下载）</option>
                  <option value="ollama">本机 Ollama 嵌入模型</option>
                  <option value="openai-compatible">
                    本机 OpenAI 兼容嵌入接口
                  </option>
                </select>
              </label>
              {form.memory.provider !== "lsa" && (
                <>
                  <input
                    aria-label="嵌入服务地址"
                    value={form.memory.url || ""}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        memory: { ...form.memory, url: e.target.value },
                      })
                    }
                  />
                  <input
                    aria-label="嵌入模型"
                    value={form.memory.model || ""}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        memory: { ...form.memory, model: e.target.value },
                      })
                    }
                  />
                </>
              )}
              <p className="workspace-note">
                LSA
                从当前资料的词语共现学习关联，少量资料和同义改写的效果有限。本地嵌入模型需提前安装，数据不会发往云端。修改后端后应重新索引原有记忆。
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                我授权勾选的能力和上述来源
              </label>
              <button
                disabled={!consent}
                onClick={() =>
                  act(async () => {
                    const { braveKey, ...rest } = form;
                    await manage({
                      action: "configure",
                      ...rest,
                      // 留空 = 保持已保存的 key 不变；有值才提交更换。
                      ...(braveKey ? { braveKey } : {}),
                      origins: form.origins
                        .split("\n")
                        .map((s) => s.trim())
                        .filter(Boolean),
                      consent,
                    });
                    setConsent(false);
                  })
                }
              >
                保存扩展授权
              </button>
            </fieldset>
          </details>
          <details hidden={focus === "terminal"} open={focus === "extensions" ? true : undefined}>
            <summary>插件安装与管理 · {data.config.plugins.length}</summary>
            <fieldset disabled={locked}>
              <p>
                支持本项目 plugin.json，以及 Codex/Claude 插件的技能与 stdio MCP 导入。检查结果会列出未兼容的入口。安装不执行脚本；技能、命令与
                MCP 入口需分别授权。升级后重新授权。
              </p>
              <input
                aria-label="远程插件地址"
                value={pluginUrl}
                onChange={(e) => setPluginUrl(e.target.value)}
                placeholder="HTTPS 插件 .tar.gz 直链"
              />
              <input
                aria-label="远程插件摘要"
                value={pluginHash}
                onChange={(e) => setPluginHash(e.target.value)}
                placeholder="发布方提供的 SHA-256"
              />
              <button
                disabled={!pluginUrl || !/^[a-f0-9]{64}$/.test(pluginHash)}
                onClick={() =>
                  act(async () => {
                    const downloaded = await manage({
                      action: "fetch-plugin",
                      url: pluginUrl,
                      sha256: pluginHash,
                      consent: true,
                    });
                    setPluginPath(downloaded.path);
                    setInspection(downloaded);
                  })
                }
              >
                下载并校验，查看安装内容
              </button>
              <input
                aria-label="插件目录"
                value={pluginPath}
                onChange={(e) => {
                  setPluginPath(e.target.value);
                  setInspection(null);
                }}
                placeholder="插件文件夹绝对路径"
              />
              <button
                onClick={() =>
                  act(async () =>
                    setInspection(
                      await manage({
                        action: "inspect-plugin",
                        path: pluginPath,
                      }),
                    ),
                  )
                }
              >
                检查插件
              </button>
              {inspection && (
                <div>
                  <pre>{JSON.stringify(inspection, null, 2)}</pre>
                  <button
                    onClick={() =>
                      act(async () => {
                        await manage({
                          action: "install-plugin",
                          path: pluginPath,
                          hash: inspection.hash,
                          consent: true,
                        });
                        setInspection(null);
                      })
                    }
                  >
                    安装此摘要对应的插件
                  </button>
                </div>
              )}
              {data.config.plugins.map((plugin) => (
                <PluginCard
                  key={plugin.id + plugin.hash + plugin.enabled}
                  plugin={plugin}
                  locked={locked}
                  manage={(body) => act(() => manage(body))}
                />
              ))}
            </fieldset>
          </details>
          <details hidden={focus === "terminal"} open={focus === "extensions" ? true : undefined}>
            <summary>MCP 服务器 · {data.config.mcpServers.length}</summary>
            <label>导入常见客户端 MCP JSON<textarea value={importText} onChange={e=>setImportText(e.target.value)} placeholder='{"mcpServers":{"tools":{"url":"https://example.com/mcp"}}}' /></label>
            <button disabled={locked||!importText.trim()} onClick={()=>act(async()=>setImported((await manage({action:"import-mcp-preview",config:JSON.parse(importText)})).servers))}>检查并转换配置</button>
            {imported.map(server=><article key={server.id}><p>{server.id} · {server.unsupported || server.url}</p>{!server.unsupported && <button disabled={locked} onClick={()=>setMcpConfig(JSON.stringify(server,null,2))}>填入下方配置，核对授权后保存</button>}</article>)}

            <fieldset disabled={locked}>
              <p>
                支持 http、sse 和插件 stdio。首次连接可将 allowedTools
                留空，发现工具后逐项填写允许的名称，再保存并重新连接。服务器工具可能产生外部写入，授权前请核对用途。
              </p>
              <textarea
                aria-label="MCP 配置"
                rows={10}
                value={mcpConfig}
                onChange={(e) => setMcpConfig(e.target.value)}
              />
              <p className="workspace-note">
                stdio 配置示例：
                {JSON.stringify({
                  id: "local-tools",
                  transport: "stdio",
                  pluginId: "example",
                  entryId: "tools",
                  allowedTools: [],
                  allowResources: false,
                })}
                。远端令牌通过 tokenEnv 引用环境变量，不能填写令牌值。
              </p>
              <button
                onClick={() =>
                  act(() =>
                    manage({
                      action: "save-mcp",
                      server: JSON.parse(mcpConfig),
                      consent: true,
                    }),
                  )
                }
              >
                保存并授权此 MCP 配置
              </button>
              {data.config.mcpServers.map((server) => (
                <article key={server.id}>
                  <strong>{server.id}</strong>
                  <p>
                    {server.url || `${server.pluginId} / ${server.entryId}`}
                  </p>
                  <div className="workspace-toolbar">
                    {server.oauth && (
                      <>
                        <button
                          onClick={() =>
                            act(async () => {
                              const result = await manage({
                                action: "oauth-start",
                                serverId: server.id,
                                consent: true,
                              });
                              setAuthorizationUrl(
                                result.authorizationUrl || "",
                              );
                            })
                          }
                        >
                          连接账户
                        </button>
                        <button
                          onClick={() =>
                            act(() =>
                              manage({
                                action: "oauth-revoke",
                                serverId: server.id,
                                consent: true,
                              }),
                            )
                          }
                        >
                          清除本机授权
                        </button>
                      </>
                    )}
                    <button
                      onClick={() =>
                        act(() =>
                          manage({
                            action: "connect-mcp",
                            serverId: server.id,
                          }),
                        )
                      }
                    >
                      连接／重连
                    </button>
                    <button
                      onClick={() =>
                        act(() =>
                          manage({
                            action: "disconnect-mcp",
                            serverId: server.id,
                          }),
                        )
                      }
                    >
                      断开
                    </button>
                    <button
                      onClick={() =>
                        setMcpConfig(JSON.stringify(server, null, 2))
                      }
                    >
                      编辑
                    </button>
                    <button
                      onClick={() =>
                        act(() =>
                          manage({ action: "remove-mcp", serverId: server.id }),
                        )
                      }
                    >
                      移除
                    </button>
                  </div>
                  <pre>
                    {JSON.stringify(
                      data.connections.find((c) => c.id === server.id) || {
                        connected: false,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </article>
              ))}
              {authorizationUrl && (
                <p>
                  <a href={authorizationUrl} target="_blank" rel="noreferrer">
                    打开账户授权页面
                  </a>{" "}
                  · 完成后返回并连接服务器，链接五分钟内有效。
                </p>
              )}
            </fieldset>
          </details>
          <details hidden={focus === "extensions" || focus === "configuration"} open={focus === "terminal" ? true : undefined}>
            <summary>通用终端</summary>
            {!data.sandbox.available && <p role="status">当前不可用：{data.sandbox.reason}</p>}
            {!workspace.permissions.grants["process.spawn"] && <p>请先在上方「授权与运行环境」中启用隔离终端并保存配置。</p>}
            <fieldset disabled={locked || !data.sandbox.available || !workspace.permissions.grants["process.spawn"]}>
              <p>
                在容器副本中执行，最长 5
                分钟。容器禁止网络，输出文件需返回文件提案后批准。文件删除不会同步到本机。
              </p>
              <textarea
                aria-label="终端命令"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
              />
              <input
                aria-label="终端输入文件"
                value={paths}
                onChange={(e) => setPaths(e.target.value)}
                placeholder="要复制的相对文件路径，以逗号分隔"
              />
              <button
                onClick={() =>
                  act(async () =>
                    setTerminal(
                      await tool("terminal_start", {
                        command,
                        paths: paths
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      }),
                    ),
                  )
                }
              >
                运行
              </button>
              <div className="workspace-toolbar">
                {data.terminals.map((t) => (
                  <button key={t.id} onClick={() => setTerminal(t)}>
                    {t.id.slice(0, 8)} · {t.status}
                  </button>
                ))}
              </div>
              {terminal && (
                <>
                  <pre aria-label="终端输出">
                    {terminal.output || "等待输出…"}
                  </pre>
                  <p>
                    {terminal.status} · exit {String(terminal.exitCode)}
                  </p>
                  <pre>{JSON.stringify(terminal.result, null, 2)}</pre>
                  <input
                    aria-label="终端标准输入"
                    value={stdin}
                    onChange={(e) => setStdin(e.target.value)}
                  />
                  <div className="workspace-toolbar">
                    <button
                      onClick={() =>
                        act(async () =>
                          setTerminal(
                            await tool("terminal_read", { id: terminal.id }),
                          ),
                        )
                      }
                    >
                      刷新输出
                    </button>
                    <button
                      disabled={terminal.status !== "running"}
                      onClick={() =>
                        act(async () => {
                          setTerminal(
                            await tool("terminal_write", {
                              id: terminal.id,
                              input: stdin + "\n",
                            }),
                          );
                          setStdin("");
                        })
                      }
                    >
                      发送输入
                    </button>
                    <button
                      disabled={terminal.status !== "running"}
                      onClick={() =>
                        act(async () =>
                          setTerminal(
                            await tool("terminal_write", {
                              id: terminal.id,
                              input: "",
                              eof: true,
                            }),
                          ),
                        )
                      }
                    >
                      结束输入
                    </button>
                    <button
                      disabled={terminal.status !== "running"}
                      onClick={() =>
                        act(async () =>
                          setTerminal(
                            await tool("terminal_stop", { id: terminal.id }),
                          ),
                        )
                      }
                    >
                      停止
                    </button>
                  </div>
                </>
              )}
            </fieldset>
          </details>
          <details hidden={Boolean(focus)}>
            <summary>浏览器与操作审批</summary>
            {!data.browser.available && <p role="status">当前不可用：{data.browser.reason}</p>}
            {!workspace.permissions.grants["browser.read"] && <p>请先在上方「授权与运行环境」中启用浏览网页、填写允许访问的网址来源并保存。</p>}
            <fieldset disabled={locked || !data.browser.available || !workspace.permissions.grants["browser.read"]}>
              <input
                aria-label="工具浏览器网址"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="已授权来源中的网址"
              />
              <div className="workspace-toolbar">
                <button
                  onClick={() =>
                    act(async () => {
                      await tool("browser_open", { url });
                      setPage(await tool("browser_snapshot"));
                      setScreen(null);
                    })
                  }
                >
                  打开网页
                </button>
                <button
                  onClick={() =>
                    act(async () => setPage(await tool("browser_snapshot")))
                  }
                >
                  读取页面
                </button>
                <button
                  onClick={() =>
                    act(async () => setScreen(await tool("browser_screenshot")))
                  }
                >
                  截图
                </button>
              </div>
              {page && <pre>{JSON.stringify(page, null, 2)}</pre>}
              {screen && (
                <img
                  alt="工具浏览器截图"
                  src={`data:${screen.mimeType};base64,${screen.data}`}
                />
              )}
              <div className="workspace-toolbar">
                <select
                  aria-label="浏览器操作"
                  value={browserAction}
                  onChange={(e) => setBrowserAction(e.target.value)}
                >
                  <option value="click">点击</option>
                  <option value="fill">填写</option>
                </select>
                <input
                  aria-label="元素 CSS 选择器"
                  value={selector}
                  onChange={(e) => setSelector(e.target.value)}
                  placeholder="CSS 选择器，例如 #search"
                />
                {browserAction === "fill" && (
                  <input
                    aria-label="浏览器填写内容"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                  />
                )}
                <button
                  onClick={() =>
                    act(() =>
                      tool("browser_action", {
                        action: browserAction,
                        selector,
                        ...(browserAction === "fill" ? { value } : {}),
                      }),
                    )
                  }
                >
                  提出操作
                </button>
              </div>
              {(workspace.extensions?.actions || []).slice(-20).map((a) => (
                <article key={a.id}>
                  <p>
                    {a.url} · {a.status}
                  </p>
                  <pre>{JSON.stringify(a.arguments, null, 2)}</pre>
                  {a.status === "pending" && (
                    <div className="workspace-toolbar">
                      <button
                        onClick={() =>
                          act(() =>
                            manage({
                              action: "browser-decision",
                              approvalId: a.id,
                              decision: "approve",
                            }),
                          )
                        }
                      >
                        批准并执行
                      </button>
                      <button
                        onClick={() =>
                          act(() =>
                            manage({
                              action: "browser-decision",
                              approvalId: a.id,
                              decision: "reject",
                            }),
                          )
                        }
                      >
                        拒绝
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </fieldset>
          </details>
          <details hidden={Boolean(focus)}>
            <summary>持久语义记忆 · {data.memories.length} 个片段</summary>
            <fieldset disabled={locked}>
              <textarea
                aria-label="新记忆内容"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="明确希望助理记住的资料或偏好"
              />
              <button
                onClick={() =>
                  act(async () => {
                    await tool("memory_add", { text: note });
                    setNote("");
                  })
                }
              >
                保存记忆
              </button>
              <div className="workspace-toolbar">
                <input
                  aria-label="记忆索引文件"
                  value={memoryPath}
                  onChange={(e) => setMemoryPath(e.target.value)}
                  placeholder="相对文本文件路径"
                />
                <button
                  onClick={() =>
                    act(() => tool("memory_add", { path: memoryPath }))
                  }
                >
                  索引／重新索引文件
                </button>
              </div>
              <div className="workspace-toolbar">
                <input
                  aria-label="记忆检索词"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="用自然语言检索"
                />
                <button
                  onClick={() =>
                    act(async () =>
                      setMatches(await tool("memory_search", { query })),
                    )
                  }
                >
                  语义检索
                </button>
              </div>
              {matches && <pre>{JSON.stringify(matches, null, 2)}</pre>}
              {data.memories.map((m) => (
                <article key={m.id}>
                  <strong>{m.title}</strong>
                  <p>{m.text.slice(0, 200)}</p>
                  <small>
                    {m.path || "用户记忆"} ·{" "}
                    {new Date(m.createdAt).toLocaleString()}
                  </small>
                  <button
                    onClick={() =>
                      act(() => tool("memory_delete", { id: m.id }))
                    }
                  >
                    删除此批记忆
                  </button>
                </article>
              ))}
            </fieldset>
          </details>
        </>
      )}
    </details>
  );
}
function PluginCard({ plugin, locked, manage }) {
  const [commands, setCommands] = useState(plugin.allowedCommands),
    [skills, setSkills] = useState(plugin.allowedSkills),
    [hooks, setHooks] = useState(plugin.allowedHooks || []);
  const toggle = (values, id) =>
    values.includes(id) ? values.filter((x) => x !== id) : [...values, id];
  return (
    <article>
      <strong>
        {plugin.manifest.name} · {plugin.manifest.version} ·{" "}
        {plugin.enabled ? "已启用" : "未启用"}
      </strong>
      <p>{plugin.manifest.description}</p>
      <small>SHA-256 {plugin.hash}</small>
      {plugin.manifest.skills.map((s) => (
        <label key={s.id}>
          <input
            type="checkbox"
            checked={skills.includes(s.id)}
            onChange={() => setSkills(toggle(skills, s.id))}
          />
          技能：{s.id}
        </label>
      ))}
      {plugin.manifest.commands.map((c) => (
        <label key={c.id}>
          <input
            type="checkbox"
            checked={commands.includes(c.id)}
            onChange={() => setCommands(toggle(commands, c.id))}
          />
          命令：{c.description} <code>{c.command}</code>
        </label>
      ))}
      {(plugin.manifest.hooks || []).map((h) => (
        <label key={h.id}>
          <input
            type="checkbox"
            checked={hooks.includes(h.id)}
            onChange={() => setHooks(toggle(hooks, h.id))}
          />
          自动执行：{h.event} · {h.id} <code>{h.command}</code>
        </label>
      ))}
      <div className="workspace-toolbar">
        <button
          disabled={locked}
          onClick={() =>
            manage({
              action: "plugin-state",
              pluginId: plugin.id,
              enabled: true,
              allowedCommands: commands,
              allowedSkills: skills,
              allowedHooks: hooks,
            })
          }
        >
          启用并保存授权
        </button>
        <button
          disabled={locked}
          onClick={() =>
            manage({
              action: "plugin-state",
              pluginId: plugin.id,
              enabled: false,
              allowedCommands: [],
              allowedSkills: [],
            })
          }
        >
          停用
        </button>
        <button
          disabled={locked}
          onClick={() =>
            manage({ action: "uninstall-plugin", pluginId: plugin.id })
          }
        >
          卸载
        </button>
      </div>
    </article>
  );
}
