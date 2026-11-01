import { useEffect, useRef, useState } from "react";
import { modelBoundary, testSummary } from "../shared/model-boundary.mjs";
import { api } from "./agent-runtime";
import { OcrSettingsSection } from "./ocr-settings";
import { DocumentEnvSettings, ResearchEnvSettings } from "./research-env-settings";
import { PrivacySettings } from "./privacy-settings";
import { PersonalRegressionSettings } from "./learning-loop";
import { JevSettings } from "./jev-settings";
import { ModelConnectionForm } from "./model-connection-form";
import { usePluginActive } from "./plugin-slots";
import { useDevInfo } from "./dev-info";
import { saveAiConsent, useAiConsent } from "./ai-consent";
// 全局 AI 授权开关：放在模型选择旁，方便找到；与「学习与隐私」中的开关同源。
function AiConsentSwitch({ granted, disabled }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const toggle = async (value) => {
    setBusy(true); setError("");
    try { await saveAiConsent(value); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return <div className="ai-consent-switch">
    <label className="model-check"><input type="checkbox" role="switch" checked={granted} disabled={disabled || busy} onChange={e => toggle(e.target.checked)}/>允许 AI 功能使用患者资料</label>
    <small className="muted">{granted ? "已授权：病历整理、AI 总结、随访摘要等直接使用患者资料，敏感信息按隐私设置脱敏后发送。" : "关闭后，每次使用 AI 功能前会单独询问。"}</small>
    {error && <small role="alert">{error}</small>}
  </div>;
}
export function ModelSettings({ onClose, onSaved }) {
  // The history regression runs in the learning plugin; hide it while off.
  const learningActive = usePluginActive("learning");
  const [devInfo, setDevInfo] = useDevInfo();
  const { stored: aiStored, loading: aiLoading } = useAiConsent();
  const dialog = useRef(null), request = useRef(null), generation = useRef(0), testedChoice = useRef(null);
  const [choices, setChoices] = useState(null), [discovery, setDiscovery] = useState(null),
    [selected, setSelected] = useState(""), [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(""), [error, setError] = useState(""), [status, setStatus] = useState("");
  function accept(result) {
    setChoices(result.choices);
    setDiscovery(result.discovery);
    setSelected(previous => result.choices.some(c => c.id === previous) ? previous : result.choices.find(c => c.current && c.selectable !== false)?.id || result.choices.find(c => c.selectable !== false)?.id || "");
    setConsent(false);
  }
  function clearFeedback() { setError(""); setStatus(""); }
  function cancel() {
    generation.current++;
    request.current?.abort();
    request.current = null;
    setBusy("");
  }
  function close() { cancel(); onClose(); }
  useEffect(() => {
    dialog.current.showModal();
    const controller = new AbortController(), id = generation.current;
    api("/api/model-choices", { signal: controller.signal }).then(value => { if (id === generation.current && !controller.signal.aborted) accept(value); }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => { controller.abort(); generation.current++; request.current?.abort(); };
  }, []);
  async function run(operation, fn) {
    const id = ++generation.current, controller = new AbortController();
    request.current?.abort(); request.current = controller;
    setBusy(operation); clearFeedback();
    try { await fn(controller.signal); }
    catch (e) { if (id === generation.current && !controller.signal.aborted) setError(e.message); }
    finally { if (id === generation.current) { setBusy(""); request.current = null; } }
  }
  const post = (path, data, signal, method = "POST") => api(path, { method, body: JSON.stringify(data), signal });
  const test = (path, data) => run("test", async signal => {
    testedChoice.current = data.id || null;
    try {
      const result = await post(path, data, signal);
      if (!signal.aborted) {
        setStatus(result.message);
        if (data.id) setChoices(rows => rows?.map(c => c.id === data.id ? { ...c, test: result.test } : c));
      }
    } catch (e) {
      if (!signal.aborted && data.id) {
        const value = await api('/api/model-choices', { signal }).catch(() => null);
        if (!signal.aborted && value) setChoices(value.choices);
      }
      throw e;
    }
  });
  const save = (path, data, method = "POST", afterSave, grantAi = false) => run("save", async signal => {
    const saved = await post(path, data, signal, method);
    if (signal.aborted) return;
    afterSave?.();
    // 连接模型时的授权即全局授权：之后各 AI 功能不再逐次勾选。
    if (grantAi && learningActive) await saveAiConsent(true).catch(() => {});
    setStatus(saved.test?.checkedAt ? `连接已保存。${testSummary(saved.test)}` : "连接已保存，尚未测试。下一次任务将使用此连接。");
    try { await onSaved(); const value = await api("/api/model-choices", { signal }); if (!signal.aborted) { accept(value); setSelected(value.choices.find(c => c.current && c.selectable !== false)?.id || value.choices.find(c => c.selectable !== false)?.id || ""); } }
    catch (e) { if (!signal.aborted) setError(`连接已启用，但刷新显示失败：${e.message}。请刷新模型列表核对当前连接。`); }
  });
  const choice = choices?.find(c => c.id === selected);
  return <dialog ref={dialog} className="model-settings-dialog" aria-labelledby="model-settings-title" onCancel={e => { e.preventDefault(); close(); }} onClose={onClose}>
    <header><h2 id="model-settings-title">模型与识别</h2><button onClick={close}>关闭</button></header>
    <div className="model-settings-body"><section>
      <h3>模型连接</h3><p>三步完成：选择服务 → 填写密钥 → 测试连接。测试通过后点「使用所选模型」或「保存并启用连接」。</p>
      {!choices && !error && <p role="status">正在读取模型列表…</p>}
      {discovery && <p role="status">{discovery.message}</p>}
      {choices?.length === 0 && <p>尚未找到模型连接。启动本机 Ollama 后刷新，或通过下方「添加模型连接」填写服务商连接。</p>}
      {choices?.filter(c => c.current && c.selectable === false).map(c => <p role="alert" key={c.id}>当前连接 {c.name}：{c.capability.message}</p>)}
      {!!choices?.length && <fieldset disabled={Boolean(busy)}>
        <label>任务使用的模型<select value={selected} onChange={e => { setSelected(e.target.value); setConsent(false); clearFeedback(); }}>
          {!selected && <option value="">请选择支持任务的模型</option>}
          {choices.map(c => <option key={c.id} value={c.id} disabled={c.selectable === false}>{c.name}{c.selectable === false ? " · 仅知识检索" : ""}{c.baseUrl ? ` · ${c.baseUrl}` : ''}</option>)}
        </select></label>
        {choice && <>
          <p>{choice.current ? '当前已填写的连接。' : '尚未切换到此连接。'}{modelBoundary(choice.local ? 'local' : 'external', true)}</p>
          <p>{choice.capability?.message || '任务能力尚未确认。'}{choice.vision === true ? (choice.visionSource === 'configuration' ? '连接配置已标记支持图片，尚需实际核对。' : '模型声明支持图片。') : '未确认图片能力，图片先通过文字识别处理。'}</p>
          <p>{testSummary(choice.test)}</p>
          {!!choice.test?.checks?.length && <ul>{choice.test.checks.map(check => <li key={check.id}>{check.ok ? '通过' : '未通过'}：{check.message}</li>)}</ul>}
        </>}
        {choice && !choice.local && !aiStored && <label className="model-check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/>允许 AI 功能使用患者资料（如病历整理、AI 总结、随访摘要），敏感信息按隐私设置脱敏后发送</label>}
        {learningActive && !aiLoading && (aiStored || !choice || choice.local) && <AiConsentSwitch granted={aiStored}/>}
        <div className="toolbar-actions"><button disabled={!choice || choice.selectable === false} onClick={() => test('/api/model-choices/test', { id: selected })}>{busy === 'test' ? '检测中…' : '测试连接'}</button>
          <button disabled={!choice || choice.selectable === false || (!choice.local && !consent && !aiStored)} onClick={() => save('/api/model-choices/select', { id: selected, consent: consent || aiStored || choice.local }, 'POST', undefined, !choice.local && consent)}>使用所选模型</button></div>
      </fieldset>}
      <p><small>连接测试只发送固定示例文本，不含患者资料；云端测试可能产生少量费用。依次检测文本、工具调用和 JSON 输出，整个检查最长等待 30 秒。</small></p>
      {busy && <p role="status">{busy === 'test' ? '正在检测连接与能力，最长等待 30 秒；可取消检测或关闭窗口。' : busy === 'save' ? '正在保存连接…' : '正在刷新模型列表…'}</p>}
      {busy === 'test' && <button onClick={() => { cancel(); setChoices(rows => rows?.map(c => c.id === testedChoice.current ? { ...c, test: { status: 'cancelled', checkedAt: new Date().toISOString(), checks: [] } } : c)); setStatus('已取消检测，当前连接未改变。'); }}>取消检测</button>}
      <button disabled={Boolean(busy)} onClick={() => run('refresh', async signal => { const value = await api('/api/model-choices', { signal }); if (!signal.aborted) { accept(value); setSelected(value.choices.find(c => c.current && c.selectable !== false)?.id || value.choices.find(c => c.selectable !== false)?.id || ""); } })}>刷新模型列表</button>
      {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
      <ModelConnectionForm busy={Boolean(busy)} onChange={clearFeedback} onTest={form => test('/api/model-settings/test', form)} aiGranted={aiStored} onSave={(form, afterSave, granted) => save('/api/model-settings', form, 'PUT', afterSave, granted)}/>
      <details className="model-settings-advanced"><summary>高级（文字识别、脱敏、计算环境等）</summary>
        <details><summary>文字识别</summary><OcrSettingsSection/></details><details><summary>患者资料脱敏</summary><PrivacySettings/></details><details><summary>文档生成环境</summary><DocumentEnvSettings/></details><details><summary>科研计算环境</summary><ResearchEnvSettings/></details>{learningActive && <PersonalRegressionSettings/>}<JevSettings/>
        <label className="model-check"><input type="checkbox" checked={devInfo} onChange={e => setDevInfo(e.target.checked)}/>显示开发者信息（上下文用量、隔离计算、验证用计划频率）</label>
      </details>
    </section></div>
  </dialog>;
}
