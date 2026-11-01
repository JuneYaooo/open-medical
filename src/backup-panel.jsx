import { useEffect, useRef, useState } from 'react';
import { api } from './agent-runtime';
import './backup-panel.css';

const date = value => value ? new Date(value).toLocaleString('zh-CN', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '从未备份';
const size = bytes => bytes < 1024*1024 ? `${(bytes/1024).toFixed(1)} KB` : `${(bytes/1024/1024).toFixed(1)} MB`;
const minute = value => { const d = new Date(value), p = n => String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const scope = '数据库备份包含患者、检验和任务等记录。任务附件原文件、知识库原件、外部项目文件与模型配置需另行保留。';
export function recoverySteps(status, item) {
  const name = status.databaseName;
  return `数据库离线恢复步骤\n\n所选备份：${item.name}\n备份时间：${date(item.createdAt)}\n备份位置：${status.directory}\n数据库位置：${status.databasePath}\n\n${scope}\n\n1. 完全退出 Open Medical 并停止相关后台服务。仅关闭窗口可能仍在后台运行。\n2. 在数据库所在目录新建一个保留目录，将当前 ${name} 以及存在的 ${name}-wal、${name}-shm 一起移入其中。保留这些文件，便于回退。\n3. 从备份目录复制所选的 ${item.name}，将副本放到上述数据库位置并命名为 ${name}。原备份文件留在 backups 中；不要将旧 WAL/SHM 混回恢复后的数据库旁。\n4. 重新启动应用，核对患者、检验与任务是否对应所选备份时间。备份之后新增的记录不在该快照中。\n5. 如原文件缺失，从另行保留的附件、知识库或项目目录恢复对应原件。数据库快照不包含这些原文件。\n6. 需要回退时，再次完全退出并停止后台，将本次恢复的数据库及其 WAL/SHM 移开，再放回第2步保留的整组文件。\n\n这份文本提供操作步骤，尚未执行恢复。\n`;
}
function useBackupState() {
  const [status,setStatus]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState('loading');
  const inFlight=useRef(false), mounted=useRef(true);
  const act=async (kind, operation)=>{
    if(inFlight.current)return;inFlight.current=true;setBusy(kind);setError('');
    try {const result=await operation();if(mounted.current)return result;}
    catch(e){if(mounted.current)setError(e.message);}
    finally {inFlight.current=false;if(mounted.current)setBusy('');}
  };
  const load=()=>act('loading',()=>api('/api/backup/status')).then(value=>{if(value)setStatus(value);return value;});
  const create=()=>act('create',()=>api('/api/backup/run','POST',{})).then(value=>{if(value)setStatus(value);return value;});
  useEffect(()=>{mounted.current=true;load();return()=>{mounted.current=false;};},[]);
  return {status,error,busy,act,load,create};
}
export function BackupStatus({onManage}) {
  const {status,error,busy,load,create}=useBackupState();
  return <div className={`backup-status ${status?.warning?'warn':'ok'}`}>
    {error ? <span role="alert">备份状态暂不可用：{error} <button disabled={!!busy} onClick={load}>重试备份状态</button></span> : <span role="status">{!status ? '正在读取数据库备份…' : !status.supported ? '当前内存实例不支持文件备份' : `上次数据库备份：${date(status.lastBackupAt)}`}</span>}
    {status?.supported && <button className="text-button" disabled={!!busy} onClick={create}>{busy==='create'?'正在备份数据库…':'立即备份数据库'}</button>}
    <button className="text-button" onClick={onManage}>管理备份</button>
  </div>;
}
export function BackupPanel() {
  const {status,error,busy,act,load,create}=useBackupState();
  const [checks,setChecks]=useState({}),[selected,setSelected]=useState(null),[notice,setNotice]=useState(''),[created,setCreated]=useState('');
  const stepHeading=useRef(null);
  useEffect(()=>{if(selected){stepHeading.current?.focus();stepHeading.current?.scrollIntoView({block:'center'});}},[selected]);
  const refresh=async()=>{setChecks({});setSelected(null);setNotice('');setCreated('');await load();};
  const run=async()=>{setNotice('');const value=await create();if(value){setChecks({});setSelected(null);setCreated(value.createdName);setNotice(value.cleanupWarning || '数据库备份已创建。');}};
  const checkFile=async item=>{
    setChecks(current=>({...current,[item.name]:null}));setNotice('');
    const result=await act(`check:${item.name}`,()=>api('/api/backup/check','POST',{name:item.name}));
    if(result)setChecks(current=>({...current,[item.name]:result}));
  };
  const open=async()=>{setNotice('');const result=await act('directory',()=>window.omwDesktop.openBackupDirectory());if(result?.opened)setNotice('备份目录已打开。');};
  const restore=async item=>{
    if(!window.confirm(`将用 ${minute(item.createdAt)} 的备份替换当前数据，当前数据会先另存一份，应用将自动重启。`))return;
    setNotice('');const result=await act(`restore:${item.name}`,()=>window.omwDesktop.restoreBackup(item.name));
    if(result?.restarting)setNotice('正在关闭并恢复备份，应用将自动重启…');
  };
  const download=()=>{
    const url=URL.createObjectURL(new Blob([recoverySteps(status,selected)],{type:'text/plain;charset=utf-8'}));
    const anchor=document.createElement('a');anchor.href=url;anchor.download=`恢复步骤-${selected.name}.txt`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    setNotice('已请求保存恢复步骤；保存位置以应用或浏览器的下载设置为准。');
  };
  return <section className="backup-panel" aria-label="备份与恢复">
    <h2>备份与恢复</h2><p>{scope}</p>
    {error && <p className="form-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="toolbar-actions"><button className="primary" disabled={!!busy || !status?.supported} onClick={run}>{busy==='create'?'正在创建…':'创建数据库备份'}</button><button className="secondary" disabled={!!busy} onClick={refresh}>刷新备份清单</button>{window.omwDesktop?.openBackupDirectory && status?.supported && <button className="secondary" disabled={!!busy} onClick={open}>打开备份目录</button>}</div>
    {busy==='loading' && <p role="status">正在读取备份清单…</p>}
    {status && !status.supported && <p>当前实例使用内存数据库，不支持文件备份。</p>}
    {status?.supported && <>
      <p className="backup-summary"><span className={`om-chip ${status.count ? "is-ok" : "is-caution"}`}>{status.count ? `最近备份 ${date(status.items[0]?.createdAt)}` : "尚无备份"}</span><span>共 {status.count} 份数据库备份。{status.autoBackup ? `每日自动备份，保留最近 ${status.retention} 份。` : `目前需手动备份，保留最近 ${status.retention} 份。`}</span></p>
      <p className="backup-warning">备份位于同一台电脑，需另行复制到其它存储位置以防设备故障。</p>
      <details><summary>备份位置与范围</summary><p>数据库：<code>{status.databasePath}</code></p><p>备份目录：<code>{status.directory}</code></p>{!window.omwDesktop?.openBackupDirectory && <p>当前在浏览器中，请在本机文件管理器中打开以上路径。</p>}<p>{scope}</p></details>
      {!status.items.length && !error && <p className="om-empty">尚未创建数据库备份。</p>}
      <ul className="backup-list">{status.items.map(item=><li key={item.name} className={created===item.name?'backup-new':''}>
        <div><strong>{date(item.createdAt)}</strong>{created===item.name && <span> · 刚刚创建</span>}<span> · 数据库快照 · {size(item.size)}</span><small>{item.name}</small></div>
        <div className="toolbar-actions"><button className="secondary" disabled={!!busy} onClick={()=>checkFile(item)}>{busy===`check:${item.name}`?'正在检查…':'检查备份'}</button>{window.omwDesktop?.restoreBackup ? <button className="secondary" disabled={!!busy} onClick={()=>restore(item)}>{busy===`restore:${item.name}`?'正在恢复…':'恢复此备份'}</button> : <button className="text-button" disabled={!!busy} onClick={()=>setSelected(item)}>手动恢复步骤</button>}</div>
        {checks[item.name] && <p role="status">数据库检查通过 · 版本 {checks[item.name].schemaVersion} · 检查于 {date(checks[item.name].checkedAt)}。未检查外部原文件。</p>}
      </li>)}</ul>
      {selected && <section className="backup-recovery" aria-label="所选备份恢复步骤"><h3 ref={stepHeading} tabIndex={-1}>恢复 {date(selected.createdAt)} 的数据库备份</h3><p>先保存步骤，再完全退出应用。以下步骤会替换当前数据库，请保留原库用于回退。</p><pre>{recoverySteps(status,selected)}</pre><button className="secondary" onClick={download}>保存恢复步骤文本</button><button className="text-button" onClick={()=>setSelected(null)}>收起恢复步骤</button></section>}
    </>}
  </section>;
}
