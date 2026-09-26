import {useState} from 'react';
export function MacPermissionHelp({onRecheck,busy}) {
 const [error,setError]=useState('');const desktop=window.omwDesktop;
 const action=async fn=>{setError('');try{await fn();}catch(e){setError(e.message);}};
 return <section className="chat-permission-help" aria-label="恢复 Mac 微信读取权限"><h3>恢复读取权限</h3><p>权限需要授予当前安装的 Open Medical。微信本身不需要重新安装。</p>
  <ol><li>打开辅助功能设置，启用 Open Medical。</li><li>若开关已开仍检测失败，移除旧条目，再添加当前安装包。</li><li>检查录屏权限；按系统提示重启工作台，再重新检测。</li></ol>
  <div className="toolbar-actions">{desktop?.openPermissionSettings&&<><button type="button" onClick={()=>action(()=>desktop.openPermissionSettings('accessibility'))}>打开辅助功能设置</button><button type="button" onClick={()=>action(()=>desktop.openPermissionSettings('screen'))}>打开录屏设置</button><button type="button" onClick={()=>action(()=>desktop.showInstalledApp())}>在访达中显示当前安装包</button></>}<button type="button" disabled={busy} onClick={onRecheck}>重新检测权限</button></div>
  {!desktop?.openPermissionSettings&&<p>系统设置 → 隐私与安全性 → 辅助功能 / 录屏与系统录音。添加「应用程序」中的 Open Medical。</p>}
  <details><summary>为什么开关打开了，检测仍不通过？</summary><p>旧安装包的授权可能已失效。临时签名版本更新后可能需要重新授权；使用同一有效证书签名和固定应用标识，才能保持可识别的更新身份。系统开关状态不能替代实际读取检查。</p></details>
  {error&&<p role="alert">{error}</p>}
 </section>;
}
