const targets = Object.freeze({
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
});
function trustedFrame(event, window, origin) {
  return Boolean(window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url.startsWith(origin + '/'));
}
function registerPermissionHelp({ipcMain,shell,app,systemPreferences,getWindow,getOrigin,platform=process.platform}) {
  const check=event=>{if(!trustedFrame(event,getWindow(),getOrigin()))throw Error('仅工作台主页面可请求此操作');};
  ipcMain.handle('omw:permission-status',event=>{check(event);return platform==='darwin'?{supported:true,accessibility:systemPreferences.isTrustedAccessibilityClient(false),screen:systemPreferences.getMediaAccessStatus('screen')}:{supported:false};});
  ipcMain.handle('omw:permission-settings',async(event,kind)=>{check(event);if(platform!=='darwin'||!Object.hasOwn(targets,kind))throw Error('未知权限设置');await shell.openExternal(targets[kind]);return{opened:true};});
  ipcMain.handle('omw:show-installed-app',event=>{check(event);if(platform!=='darwin'||!app.isPackaged)throw Error('请使用已安装的 Mac 桌面版');const path=require('node:path');const bundle=path.resolve(app.getPath('exe'),'../../..');shell.showItemInFolder(bundle);return{shown:true};});
}
module.exports={registerPermissionHelp,trustedFrame};
