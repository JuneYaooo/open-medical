import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {registerPermissionHelp}=createRequire(import.meta.url)('../desktop/permission-help.cjs');
test('permission recovery only opens fixed settings from the trusted main frame; never changes grants',async()=>{
 const handlers={},opened=[],shown=[];const frame={url:'http://127.0.0.1:1234/?view=settings'},wc={mainFrame:frame};const event={sender:wc,senderFrame:frame};
 registerPermissionHelp({ipcMain:{handle:(name,fn)=>handlers[name]=fn},shell:{openExternal:async url=>opened.push(url),showItemInFolder:p=>shown.push(p)},app:{isPackaged:true,getPath:()=>'/Applications/Open Medical.app/Contents/MacOS/Open Medical'},systemPreferences:{isTrustedAccessibilityClient:prompt=>{assert.equal(prompt,false);return false;},getMediaAccessStatus:()=> 'denied'},getWindow:()=>({webContents:wc}),getOrigin:()=> 'http://127.0.0.1:1234',platform:'darwin'});
 assert.equal(handlers['omw:permission-status'](event).accessibility,false);
 await handlers['omw:permission-settings'](event,'accessibility');assert.match(opened[0],/Privacy_Accessibility$/);
 await assert.rejects(handlers['omw:permission-settings'](event,'https://attacker.invalid'),/未知/);
 await assert.rejects(handlers['omw:permission-settings']({...event,senderFrame:{url:frame.url}},'screen'),/主页面/);
 frame.url='https://attacker.invalid';assert.throws(()=>handlers['omw:show-installed-app'](event),/主页面/);frame.url='http://127.0.0.1:1234/';
 handlers['omw:show-installed-app'](event);assert.deepEqual(shown,['/Applications/Open Medical.app']);
});
