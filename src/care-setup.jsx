import { useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { api } from "./agent-runtime";
import { Modal } from "./components";

const STEPS = [
  ["corp", "企业信息"],
  ["kf", "接收患者消息"],
  ["app", "提醒医生"],
  ["contact", "客户与群", "可选"],
  ["finish", "试运行"],
];
const OPEN_KEY = "omw-care-setup-open";
const LIVE_WAIT_MS = 2 * 60000;

// What is already connected, derived from GET /api/care/settings.
export function setupProgress(settings) {
  const c = settings?.channels || {};
  const configured = (id) => Boolean(c.list?.find((item) => item.id === id)?.configured);
  const done = {
    corp: Boolean(c.corp?.corpId),
    kf: configured("wecom-kf"),
    app: Boolean(c.notifier?.configured && settings?.alerts?.notifyUserIds?.length),
    contact: Boolean(c.corp?.hasContactSecret),
  };
  return { done, count: Object.values(done).filter(Boolean).length, total: 4, essential: done.corp && done.kf && done.app };
}
// Lets other pages (the home checklist) open the wizard on arrival.
export function requestCareSetup() { try { sessionStorage.setItem(OPEN_KEY, "1"); } catch { /* storage unavailable */ } }
export function takeCareSetupRequest() {
  try { const wanted = sessionStorage.getItem(OPEN_KEY) === "1"; sessionStorage.removeItem(OPEN_KEY); return wanted; } catch { return false; }
}

function CopyText({ value }) {
  const [copied, setCopied] = useState(false);
  return <span className="care-copy"><code>{value}</code>
    <button type="button" className="secondary" onClick={() => navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "已复制" : "复制"}</button></span>;
}

// One connection check, with the fix spelled out when WeCom rejects the IP.
function Result({ result }) {
  if (!result) return null;
  if (result.error) return <p role="alert" className="care-error">{result.error}</p>;
  return <div className={`care-setup-result ${result.ok === true ? "ok" : result.ok === false ? "bad" : ""}`} role="status">
    <p>{result.ok === true ? "✓ " : result.ok === false ? "✗ " : ""}{result.detail}</p>
    {result.errcode === 60020 && <div className="care-hint">
      <p>把下面的 IP 加到该应用详情页底部的「企业可信 IP」中，保存后再测试：</p>
      {result.ip ? <CopyText value={result.ip} /> : <p>（企业微信没有返回 IP，可在浏览器搜索「我的 IP」查看本机公网 IP）</p>}
      <p>企业微信要求先配置「可信域名」或「接收消息服务器 URL」才能填写可信 IP。没有自己的域名时可以先跳过这一步，提醒仍会出现在工作台里。家庭宽带的公网 IP 可能会变，变了以后需要重新添加。</p>
    </div>}
  </div>;
}

function Guide({ items }) {
  return <ol className="care-setup-guide">{items.map((item, index) => <li key={index}>{item}</li>)}</ol>;
}

export function CareSetup({ onClose, onChanged }) {
  const [settings, setSettings] = useState(null);
  const [step, setStep] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [results, setResults] = useState({});
  const [form, setForm] = useState({ corpId: "", kfSecret: "", openKfId: "", agentId: "", appSecret: "", notifyUserIds: "", contactSecret: "", mode: "draft", modelConsent: false });
  const [accounts, setAccounts] = useState(null);
  const set = (changes) => setForm((f) => ({ ...f, ...changes }));

  async function reload() {
    const value = await api("/api/care/settings");
    setSettings(value);
    return value;
  }
  useEffect(() => {
    reload().then((value) => {
      const { done } = setupProgress(value);
      setStep(STEPS.findIndex(([id]) => id !== "contact" && !done[id]) < 0 ? STEPS.length - 1 : STEPS.findIndex(([id]) => id !== "contact" && !done[id]));
      setForm((f) => ({ ...f, corpId: value.channels?.corp?.corpId || "", openKfId: value.channels?.kf?.openKfId || "", agentId: value.channels?.app?.agentId || "",
        notifyUserIds: (value.alerts?.notifyUserIds || []).join(","), mode: value.autoReply?.mode || "draft", modelConsent: Boolean(value.processing?.modelConsent) }));
    }).catch((e) => setError(e.message));
  }, []);

  async function run(key, fn) {
    setBusy(key); setError("");
    try { await fn(); onChanged?.(); }
    catch (e) { setError(e.message); }
    finally { setBusy(""); }
  }
  const save = async (body) => { await api("/api/care/settings", "PUT", body); return reload(); };
  const test = async (id) => {
    const value = await api("/api/care/settings/test", "POST", { only: [id] });
    const result = value.results.find((r) => r.id === id) || { detail: "未检测" };
    setResults((r) => ({ ...r, [id]: result }));
    return result.ok === true;
  };

  if (!settings || step === null) return <Modal title="企业微信接入向导" onClose={onClose}>
    {error ? <p role="alert" className="care-error">{error}</p> : <p className="care-loading"><Loader2 size={16} className="spin" />正在读取当前配置…</p>}
  </Modal>;

  const progress = setupProgress(settings);
  const c = settings.channels || {};
  const id = STEPS[step][0];
  const next = () => { setError(""); setStep((s) => Math.min(STEPS.length - 1, s + 1)); };
  const secretPlaceholder = (has) => has ? "已保存，留空不修改" : "粘贴 Secret";

  return <Modal title="企业微信接入向导" onClose={onClose} wide>
    <div className="care-setup">
      <nav className="care-setup-steps" aria-label="接入步骤">
        {STEPS.map(([key, label, note], index) => <button key={key} type="button" aria-current={index === step ? "step" : undefined} className={results[key]?.ok === false ? "bad" : progress.done[key] ? "done" : ""} onClick={() => { setError(""); setStep(index); }}>
          <span aria-hidden="true">{results[key]?.ok === false ? "!" : progress.done[key] ? "✓" : index + 1}</span>{label}{note && <small>{note}</small>}</button>)}
      </nav>
      <section className="care-setup-body">
        {id === "corp" && <>
          <h3>第 1 步：企业信息</h3>
          <p>建议由管理员在电脑上登录 <a href="https://work.weixin.qq.com/wework_admin/frame" target="_blank" rel="noreferrer">企业微信管理后台</a>，边看边填。患者对接的是助理的企业微信账号，医生只接收提醒。</p>
          <Guide items={["打开「我的企业 → 企业信息」", "在页面最下方复制「企业 ID」（ww 开头）"]} />
          <label>企业 ID<input value={form.corpId} onChange={(e) => set({ corpId: e.target.value.trim() })} placeholder="wwxxxxxxxxxxxxxxxx" disabled={c.corp?.from?.corpId === "options"} /></label>
          <footer><button type="button" className="primary" disabled={!form.corpId || Boolean(busy)} onClick={() => run("corp", async () => { await save({ channels: { corp: { corpId: form.corpId } } }); next(); })}>{busy === "corp" ? "正在保存…" : "保存，下一步"}</button></footer>
        </>}

        {id === "kf" && <>
          <h3>第 2 步：接收患者消息（微信客服）</h3>
          <p>患者在微信里点开客服链接就能发消息，不用加好友。消息会自动记录、分诊，科普问题可以按你的设置自动回复。</p>
          <Guide items={[
            "打开「应用管理 → 微信客服」，创建一个客服账号，名称建议写「某某医生随访助手」",
            "在微信客服页面进入「API」设置，把这个客服账号交给「企业内部开发」通过 API 管理",
            "在同一页面查看 Secret（会发送到管理员的企业微信里），粘贴到下面",
          ]} />
          <p className="care-hint">注意：交给 API 管理后，这个客服账号的消息改在本工作台查看和回复，企业微信客户端里的接待人员不会再收到。</p>
          <label>微信客服 Secret<input type="password" autoComplete="off" value={form.kfSecret} onChange={(e) => set({ kfSecret: e.target.value.trim() })} placeholder={secretPlaceholder(c.kf?.hasSecret)} /></label>
          <footer><button type="button" className="secondary" disabled={(!form.kfSecret && !c.kf?.hasSecret) || Boolean(busy)} onClick={() => run("accounts", async () => {
            if (form.kfSecret) await save({ channels: { kf: { secret: form.kfSecret } } });
            set({ kfSecret: "" });
            try {
              const value = await api("/api/care/settings/kf-accounts");
              setAccounts(value.accounts);
              setResults((r) => ({ ...r, kfAccounts: value.accounts.length ? null : { ok: false, detail: "Secret 可用，但还没有交给 API 管理的客服账号，请回到第 2 条勾选账号后重试" } }));
              if (value.accounts.length === 1) set({ openKfId: value.accounts[0].openKfId });
            } catch (e) { setAccounts(null); setResults((r) => ({ ...r, kfAccounts: { ok: false, detail: e.message } })); }
          })}>{busy === "accounts" ? "正在读取…" : "保存并读取客服账号"}</button></footer>
          <Result result={results.kfAccounts} />
          {accounts?.length > 0 && <label>选择接待患者的客服账号<select value={form.openKfId} onChange={(e) => set({ openKfId: e.target.value })}>
            <option value="">请选择</option>{accounts.map((a) => <option key={a.openKfId} value={a.openKfId}>{a.name}</option>)}</select></label>}
          <Result result={results.kf} />
          <footer>
            <button type="button" className="secondary" onClick={next}>暂时跳过</button>
            <button type="button" className="primary" disabled={!form.openKfId || Boolean(busy)} onClick={() => run("kf", async () => { await save({ channels: { kf: { openKfId: form.openKfId } } }); if (await test("kf")) next(); })}>{busy === "kf" ? "正在测试…" : "保存并测试"}</button>
          </footer>
        </>}

        {id === "app" && <>
          <h3>第 3 步：提醒医生（自建应用）</h3>
          <p>患者出现胸痛、呼吸困难等红旗症状，或有需要医生处理的消息时，通过这个应用推送到医生的企业微信。</p>
          <Guide items={[
            "打开「应用管理 → 自建 → 创建应用」，名称如「患者消息提醒」，可见范围选择医生（和助理）",
            "在应用详情页复制 AgentId，并查看 Secret",
            "在「通讯录」打开医生的成员详情，复制「账号」，即 UserID",
          ]} />
          <div className="care-setup-row">
            <label>AgentId<input value={form.agentId} onChange={(e) => set({ agentId: e.target.value.trim() })} placeholder="1000002" /></label>
            <label>应用 Secret<input type="password" autoComplete="off" value={form.appSecret} onChange={(e) => set({ appSecret: e.target.value.trim() })} placeholder={secretPlaceholder(c.app?.hasSecret)} /></label>
          </div>
          <label>接收提醒的成员 UserID（多个用逗号分隔）<input value={form.notifyUserIds} onChange={(e) => set({ notifyUserIds: e.target.value })} placeholder="zhangyisheng" /></label>
          <Result result={results.app} />
          {results.notify && <Result result={results.notify} />}
          <footer>
            <button type="button" className="secondary" onClick={next}>暂时跳过</button>
            {results.app?.ok && <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => run("notify", async () => {
              const value = await api("/api/care/settings/test", "POST", { only: [], notify: true });
              setResults((r) => ({ ...r, notify: value.notify }));
            })}>{busy === "notify" ? "正在发送…" : "给医生发一条测试提醒"}</button>}
            {results.app?.ok ? <button type="button" className="primary" onClick={next}>下一步</button>
              : <button type="button" className="primary" disabled={!form.agentId || !form.notifyUserIds.trim() || Boolean(busy)} onClick={() => run("app", async () => {
                await save({ channels: { app: { agentId: form.agentId, ...(form.appSecret ? { secret: form.appSecret } : {}) } }, alerts: { notifyUserIds: form.notifyUserIds.split(/[,，\s]+/).filter(Boolean) } });
                set({ appSecret: "" });
                await test("app");
              })}>{busy === "app" ? "正在测试…" : "保存并测试"}</button>}
          </footer>
        </>}

        {id === "contact" && <>
          <h3>第 4 步：客户与群（可选）</h3>
          <p>接入后可以同步助理企业微信里的客户和客户群、把客户关联到患者档案，并生成群发任务（助理在企业微信里确认后才会发出）。</p>
          <p className="care-hint">由于没有开通会话存档，助理和患者在企业微信里的一对一聊天、群聊内容不会被自动收集；需要自动记录的对话请引导患者使用客服链接。</p>
          <Guide items={[
            "打开「客户与上下游 → 客户联系」，确认助理账号在「使用范围」内",
            "在客户联系页面进入「API」，查看 Secret",
          ]} />
          <label>客户联系 Secret<input type="password" autoComplete="off" value={form.contactSecret} onChange={(e) => set({ contactSecret: e.target.value.trim() })} placeholder={secretPlaceholder(c.corp?.hasContactSecret)} /></label>
          <Result result={results.contact} />
          <footer>
            <button type="button" className="secondary" onClick={next}>跳过</button>
            <button type="button" className="primary" disabled={(!form.contactSecret && !c.corp?.hasContactSecret) || Boolean(busy)} onClick={() => run("contact", async () => {
              if (form.contactSecret) await save({ channels: { corp: { corpSecret: form.contactSecret } } });
              set({ contactSecret: "" });
              if (await test("contact")) next();
            })}>{busy === "contact" ? "正在测试…" : "保存并测试"}</button>
          </footer>
        </>}

        {id === "finish" && <Finish settings={settings} progress={progress} form={form} set={set} busy={busy} run={run}
          onDone={() => run("finish", async () => {
            const categories = settings.autoReply?.categories?.length ? undefined : ["education", "admin", "chitchat"];
            await save({ autoReply: { mode: form.mode, ...(form.mode === "auto" && categories ? { categories } : {}) }, processing: { modelConsent: form.modelConsent } });
            onClose();
          })} />}
        {error && <p role="alert" className="care-error">{error}</p>}
      </section>
    </div>
  </Modal>;
}

function Finish({ settings, progress, form, set, busy, run, onDone }) {
  const [link, setLink] = useState(null);
  const [live, setLive] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  function waitForMessage() {
    const baseline = settings.channels?.kfLastInboundAt || "";
    const deadline = Date.now() + LIVE_WAIT_MS;
    setLive({ state: "waiting" });
    const poll = async () => {
      try {
        await api("/api/care/sync", "POST", {}).catch(() => {});
        const value = await api("/api/care/settings");
        const last = value.channels?.kfLastInboundAt || "";
        if (last && last > baseline) return setLive({ state: "received", at: last });
      } catch { /* keep waiting */ }
      if (Date.now() > deadline) return setLive({ state: "timeout" });
      timer.current = setTimeout(poll, 4000);
    };
    poll();
  }

  return <>
    <h3>第 5 步：试运行</h3>
    {!progress.done.kf && <p className="care-hint">微信客服还没接好，患者消息暂时无法自动收集。可以回到第 2 步完成后再试运行。</p>}
    {progress.done.kf && <>
      <p>生成患者咨询链接：发给患者，或者用任意二维码工具把它做成二维码贴在诊室。企业微信后台的客服账号详情页也可以直接下载二维码。</p>
      {link ? <CopyText value={link.url} /> : <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => run("link", async () => setLink(await api("/api/care/settings/kf-link", "POST", {})))}>{busy === "link" ? "正在生成…" : "生成咨询链接"}</button>}
      {link && <div className="care-setup-live">
        <p>用你自己的微信打开这个链接，发一句「测试」，确认整条链路是通的。</p>
        {!live || live.state === "timeout" ? <button type="button" className="secondary care-setup-start" onClick={waitForMessage}>{live ? "再等一次" : "我发好了，开始检测"}</button> : null}
        {live?.state === "waiting" && <p role="status" className="care-loading"><Loader2 size={16} className="spin" />正在等待你的消息…（最多 2 分钟）</p>}
        {live?.state === "received" && <p role="status" className="care-setup-result ok">✓ 已收到测试消息，链路已接通。它会出现在「全部消息」里并标为「未关联患者」，处理或忽略都可以。</p>}
        {live?.state === "timeout" && <p className="care-hint">2 分钟内没有收到消息。请确认消息是通过这个链接发出的，并且客服账号已交给 API 管理。</p>}
      </div>}
    </>}
    <fieldset className="care-setup-mode">
      <legend>收到患者消息后怎么处理</legend>
      {[["draft", "生成草稿，由我确认后发送（推荐）"], ["auto", "科普、就诊安排和寒暄类问题自动回复，其余生成草稿"], ["off", "只记录和提醒，不生成回复"]].map(([value, label]) =>
        <label key={value} className="care-check"><input type="radio" name="setup-mode" checked={form.mode === value} onChange={() => set({ mode: value })} /><span>{label}</span></label>)}
      <label className="care-check"><input type="checkbox" checked={form.modelConsent} onChange={(e) => set({ modelConsent: e.target.checked })} /><span>允许把患者消息发送给已配置的模型做分诊与起草<small>不含姓名和电话。不开启时只用规则识别，红旗症状仍会提醒。</small></span></label>
      <p className="care-hint">红旗症状始终立即提醒医生；只有已确认知情同意的患者才会收到自动回复。</p>
    </fieldset>
    <p className="care-hint">已完成 {progress.count}/{progress.total} 项连接。所有设置以后都可以在「设置」页修改，也可以在对话中让助手帮你调整。</p>
    <footer><button type="button" className="primary" disabled={Boolean(busy)} onClick={onDone}>{busy === "finish" ? "正在保存…" : "完成"}</button></footer>
  </>;
}
