import {openTool} from "./navigation-ui.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { fixture } from './helpers.mjs';
import { listScales, calculateScale } from '../server/medical/scales.mjs';

const output='output/playwright/journeys-20260924';
const skip=!existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')||!existsSync('dist/index.html');
mkdirSync(output,{recursive:true});
async function setup(t){
 const installed=mkdtempSync(resolve(output,'plugins-'));
 const cleanups=[];
 const f=await fixture({after:fn=>cleanups.push(fn)},{extensions:{directory:installed}}),browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(12000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 t.after(async()=>{await page.screenshot({path:join(output,t.name.replace(/[^a-z0-9-]/gi,'_')+'.png'),fullPage:true});await browser.close();for(const cleanup of cleanups)await cleanup();rmSync(installed,{recursive:true,force:true});assert.deepEqual(errors,[]);});
 await page.goto(f.origin);return {...f,page};
}
async function tool(page,name){
 await openTool(page,name.startsWith('科研')?'科研统计':'临床速查');
}

test('journey research CSV to statistics comparisons sample-size and deidentified download',{skip},async t=>{
 const f=await setup(t),{page}=f;
 // Upload through the normal attachment UI; no data API seeding.
 const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'添加材料',exact:true}).click();
 await(await chooser).setFiles([{name:'journey-cohort.csv',mimeType:'text/csv',buffer:Buffer.from('name,group,value,binary\n合成甲,A,1,0\n合成乙,A,2,0\n合成丙,A,4,1\n合成丁,B,7,1\n合成戊,B,8,1\n合成己,B,10,0')},{name:'second-cohort.csv',mimeType:'text/csv',buffer:Buffer.from('name,group,value\n第二资料,A,999\n第二资料乙,B,1001\n第二资料丙,B,1000')}]);
 await page.getByRole('textbox',{name:'任务内容'}).fill('本地整理这份合成数据，不进行临床判断');
 await page.getByRole('button',{name:'发送任务',exact:true}).click();
 await page.locator('.composer').waitFor();
 await page.waitForFunction(()=>!document.querySelector('button[title="停止执行"]'));
 await tool(page,'科研统计 统计工具');
 const view=page.locator('.research-view');
 await view.locator('select').nth(0).selectOption({index:1});
 await page.waitForFunction(()=>document.querySelector('.research-view select:nth-of-type(2)')?.options.length>1);
 await view.locator('select').nth(1).selectOption({index:1});
 await page.getByRole('button',{name:'分析数据集',exact:true}).click();
 await view.locator('.research-table').waitFor();assert.match(await view.locator('.research-table').innerText(),/5\.3333/);
 await page.getByPlaceholder('结局变量列名',{exact:true}).fill('value');await page.getByPlaceholder('分组变量列名',{exact:true}).fill('group');
 for(const method of ['welch-t','mann-whitney','chi-square','fisher']){
  await page.getByPlaceholder('结局变量列名',{exact:true}).fill(['chi-square','fisher'].includes(method)?'binary':'value');
  await view.locator('select').nth(2).selectOption(method);
  const response=page.waitForResponse(r=>r.url().endsWith('/api/research/test'));
  await page.getByRole('button',{name:'运行检验',exact:true}).click();assert.equal((await response).status(),200);
  await view.locator('pre').waitFor();assert.match(await view.locator('pre').innerText(),/pValue|p_value|"p"/);
 }
 await page.getByPlaceholder('预期差值 Δ').fill('5');await page.getByPlaceholder('标准差 σ').fill('10');
 await page.getByRole('button',{name:'计算',exact:true}).click();await view.getByText(/每组/).waitFor();assert.match(await view.innerText(),/共 126 例/);
 await view.locator('select').nth(3).selectOption('proportions');await page.getByPlaceholder('对照组率 p1').fill('0.2');await page.getByPlaceholder('试验组率 p2').fill('0.4');
 await page.getByRole('button',{name:'计算',exact:true}).click();await view.getByText(/每组/).waitFor();
 await page.getByPlaceholder('需要脱敏的列名，逗号分隔（如 姓名,住院号）').fill('name');
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'生成脱敏 CSV'}).click();const file=await download;const path=join(output,'deidentified.csv');await file.saveAs(path);assert.doesNotMatch(readFileSync(path,'utf8'),/合成甲|合成乙/);
 await view.locator('select').nth(1).selectOption({label:'second-cohort.csv'});
 assert.equal(await view.locator('.research-table').count(),0);assert.equal(await view.locator('pre').count(),0);
 await page.getByRole('button',{name:'分析数据集',exact:true}).click();await view.locator('.research-table').waitFor();assert.match(await view.locator('.research-table').innerText(),/均值 1000/);
 // The advertised whole-page action must retain the same tool.
 await page.reload();await page.getByRole('heading',{name:'科研统计 · 数据分析',exact:true}).waitFor();
});

test('journey all clinical scales laboratory codes and adverse-reaction calculator handoff',{skip},async t=>{
 const {page}=await setup(t);await tool(page,'临床速查 量表 · 检验 · 编码 · ADR');
 const view=page.locator('.clinical-ref-view');
 for(const scale of listScales()){
  await view.locator('select').first().selectOption(scale.id);
  const answers={};
  for(const item of scale.items){
   const input=view.locator('.scale-item').filter({hasText:item.label}).locator('input,select');
   if(item.type==='select'){answers[item.key]=item.choices[0].label;await input.selectOption(item.choices[0].label);}
   else {answers[item.key]=({age:40,weight:60,height:170,creatinine:70})[item.key]??Math.max(item.min??1,1);await input.fill(String(answers[item.key]));}
  }
  const response=page.waitForResponse(r=>r.url().includes('/calculate'));
  await view.getByRole('button',{name:'计算',exact:true}).click();assert.equal((await response).status(),200,scale.id);
  await view.locator('.drg-result').waitFor();assert.equal(await view.locator('.drg-code b').innerText(),String(calculateScale(scale.id,answers).score),scale.id);
 }
 await view.getByRole('button',{name:'检验速查',exact:true}).click();await page.getByPlaceholder('指标名/缩写，如 血钾、WBC、肌钙蛋白').fill('WBC');await view.getByRole('button',{name:'查询',exact:true}).click();await view.getByText('白细胞计数 WBC',{exact:true}).waitFor();
 await view.getByRole('button',{name:'手术编码',exact:true}).click();await page.getByPlaceholder('术式名或编码，如 胆囊、51.23').fill('51.23');await view.getByRole('button',{name:'查询',exact:true}).click();await view.locator('.literature-item').waitFor();assert.match(await view.innerText(),/胆囊/);
 await view.getByRole('button',{name:'不良反应筛查',exact:true}).click();await page.getByPlaceholder(/当前用药/).fill('依那普利');await page.getByPlaceholder(/可疑临床表现/).fill('干咳');await view.getByRole('button',{name:'筛查',exact:true}).click();await view.locator('.literature-item').first().waitFor();
 await page.getByRole('button',{name:'打开 Naranjo 因果评估量表 →',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.clinical-ref-view select')?.value==='naranjo');
});

test('journey project connect browse pin archive restore and reopen',{skip},async t=>{
 const {page}=await setup(t),root=mkdtempSync(join(tmpdir(),'journey-project-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(join(root,'note.md'),'# Journey project\nOriginal text');
 await page.getByRole('button',{name:'查看全部项目文件',exact:true}).click();
 await page.getByRole('button',{name:'连接项目',exact:true}).click();
 await page.screenshot({path:join(output,'project-connect-form.png')});
 await page.getByLabel('名称',{exact:true}).fill('完整动线项目');
 await page.getByLabel('文件夹绝对路径',{exact:true}).fill(root);
 await page.getByLabel('授权此工作区读取该目录').check();
 await page.getByRole('button',{name:'创建工作区',exact:true}).click();
 await page.locator('.conversation-head h1').filter({hasText:'完整动线项目'}).waitFor();
 await page.getByRole('tab',{name:'文件',exact:true}).click();await page.getByText('note.md',{exact:true}).first().click();
 await page.getByText('Original text',{exact:false}).first().waitFor();
 await page.getByRole('button',{name:'查看全部项目文件',exact:true}).click();
 await page.getByRole('button',{name:'固定完整动线项目',exact:true}).click();await page.getByRole('button',{name:'取消固定完整动线项目',exact:true}).waitFor();
 await page.getByRole('button',{name:'归档完整动线项目',exact:true}).click();
 await page.getByRole('button',{name:'已归档',exact:true}).click();await page.getByRole('button',{name:'恢复完整动线项目',exact:true}).click();
 await page.getByRole('button',{name:'使用中',exact:true}).click();await page.locator('.directory-open',{hasText:'完整动线项目'}).click();
 await page.locator('.conversation-head h1').filter({hasText:'完整动线项目'}).waitFor();
 await page.reload();await page.getByRole('button',{name:'查看全部项目文件',exact:true}).click();await page.locator('.directory-open',{hasText:'完整动线项目'}).click();
 await page.locator('.conversation-head h1').filter({hasText:'完整动线项目'}).waitFor();assert.equal(readFileSync(join(root,'note.md'),'utf8'),'# Journey project\nOriginal text');
});

test('journey extensions authorize terminal plugin MCP memory revoke and uninstall',{skip:skip||process.env.JOURNEY_DOCKER!=='1',timeout:120000},async t=>{
 const {page,json}=await setup(t),root=mkdtempSync(join(tmpdir(),'journey-ext-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 await page.getByRole('button',{name:'查看全部项目文件',exact:true}).click();await page.getByRole('button',{name:'连接项目',exact:true}).click();
 await page.getByLabel('名称',{exact:true}).fill('扩展闭环项目');await page.getByLabel('文件夹绝对路径',{exact:true}).fill(root);await page.getByLabel('授权此工作区读取该目录').check();await page.getByRole('button',{name:'创建工作区',exact:true}).click();
 await page.getByRole('tab',{name:'设置',exact:true}).click();await page.getByText('工具、插件与记忆',{exact:true}).click();
 await page.getByText('授权与运行环境',{exact:true}).click();
 for(const label of ['隔离终端','已安装插件','已授权 MCP 工具','检索记忆','保存与删除记忆'])await page.getByLabel(label,{exact:true}).check();
 await page.getByLabel('沙箱镜像',{exact:true}).fill('open-medical-runtime:0.9-full');await page.getByLabel('我授权勾选的能力和上述来源').check();
 const configured=page.waitForResponse(r=>r.url().endsWith('/extensions')&&r.request().method()==='POST');await page.getByRole('button',{name:'保存扩展授权',exact:true}).click();assert.equal((await configured).status(),200);
 await page.getByText('通用终端',{exact:true}).click();await page.getByLabel('终端命令',{exact:true}).fill("printf 'JOURNEY_TERMINAL_OK\\n'");await page.getByRole('button',{name:'运行',exact:true}).click();
 for(let i=0;i<30;i++){await page.getByRole('button',{name:'刷新输出',exact:true}).click();if((await page.getByLabel('终端输出').innerText()).includes('JOURNEY_TERMINAL_OK'))break;await page.waitForTimeout(100);}
 assert.match(await page.getByLabel('终端输出').innerText(),/JOURNEY_TERMINAL_OK/);
 await page.getByText(/插件安装与管理 ·/).click();await page.getByLabel('插件目录',{exact:true}).fill(resolve('examples/plugins/local-tools'));await page.getByRole('button',{name:'检查插件',exact:true}).click();await page.getByRole('button',{name:'安装此摘要对应的插件',exact:true}).click();
 const plugin=page.locator('article').filter({has:page.locator('strong',{hasText:'本地工具示例'})});await plugin.getByLabel('技能：guide',{exact:true}).check();await plugin.getByLabel(/命令：验证插件隔离执行/).check();await plugin.getByRole('button',{name:'启用并保存授权',exact:true}).click();await plugin.getByText(/已启用/).waitFor();
 await page.getByText(/MCP 服务器 ·/).click();await page.getByLabel('MCP 配置',{exact:true}).fill(JSON.stringify({id:'journey-mcp',transport:'stdio',pluginId:'local-tools',entryId:'tools',allowedTools:['sum_numbers'],allowResources:true}));
 await page.getByRole('button',{name:'保存并授权此 MCP 配置',exact:true}).click();const mcp=page.locator('article').filter({has:page.locator('strong',{hasText:'journey-mcp'})});const connected=page.waitForResponse(r=>r.url().endsWith('/extensions')&&r.request().postDataJSON()?.action==='connect-mcp');await mcp.getByRole('button',{name:'连接／重连',exact:true}).click();const connection=await connected;assert.equal(connection.status(),200,await connection.text());await mcp.getByText(/sum_numbers/).waitFor();assert.match(await mcp.innerText(),/"connected": true/);
 // UI has no arbitrary MCP-call form: independently verify the connected tool's result.
 const workspace=(await json('/api/workspaces')).data.workspaces.find(w=>w.title==='扩展闭环项目');
 const result=await json(`/api/workspaces/${workspace.id}/tools`,'POST',{tool:'mcp_call',arguments:{serverId:'journey-mcp',tool:'sum_numbers',argumentsJson:JSON.stringify({values:[2,3,5]})}});
 assert.equal(result.status,200,JSON.stringify(result.data));assert.match(JSON.stringify(result.data),/10/);
 await page.getByText(/持久语义记忆 ·/).click();await page.getByLabel('新记忆内容',{exact:true}).fill('JOURNEY_MEMORY 使用合成样本测试持久记忆');await page.getByRole('button',{name:'保存记忆',exact:true}).click();
 await page.getByLabel('记忆检索词',{exact:true}).fill('JOURNEY_MEMORY');await page.getByRole('button',{name:'语义检索',exact:true}).click();await page.locator('pre').filter({hasText:'JOURNEY_MEMORY'}).waitFor();
 await page.getByRole('button',{name:'删除此批记忆',exact:true}).click();await page.getByText('持久语义记忆 · 0 个片段',{exact:true}).waitFor();
 await mcp.getByRole('button',{name:'断开',exact:true}).click();await mcp.getByRole('button',{name:'移除',exact:true}).click();await page.getByText('MCP 服务器 · 0',{exact:true}).waitFor();
 await plugin.getByRole('button',{name:'停用',exact:true}).click();await plugin.getByText(/未启用/).waitFor();await plugin.getByRole('button',{name:'卸载',exact:true}).click();await page.getByText('插件安装与管理 · 0',{exact:true}).waitFor();
 await page.getByLabel('已授权 MCP 工具',{exact:true}).uncheck();await page.getByLabel('我授权勾选的能力和上述来源').check();await page.getByRole('button',{name:'保存扩展授权',exact:true}).click();
 const denied=await json(`/api/workspaces/${workspace.id}/tools`,'POST',{tool:'mcp_list',arguments:{}});assert.ok(denied.status>=400);
});
