import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { dashboardLabGroups, dashboardLabLayout } from '../shared/patient-dashboard.mjs';
import { fixture } from './helpers.mjs';

test('lab visualization keeps units separate, preserves zero and still draws single-day or conflicting records as scatter',()=>{
  const g=dashboardLabGroups([
    {item:'标志物',unit:'U/L',value:0,date:'2026-01-01'},
    {item:'标志物',unit:'U/L',value:10,date:'2026-02-01'},
    {item:'标志物',unit:'mg/L',value:20,date:'2026-01-01'},
    {item:'同日冲突',unit:'U/L',value:1,date:'2026-01-01'},
    {item:'同日冲突',unit:'U/L',value:2,date:'2026-01-01'},
    {item:'同日冲突',unit:'U/L',value:3,date:'2026-02-01'},
    {item:'无单位',value:1,date:'2026-01-01'}, {item:'无单位',value:2,date:'2026-02-01'},
    {item:'坏日期',unit:'U/L',value:1,date:'2026-02-30'}, {item:'坏日期',unit:'U/L',value:2,date:'2026-03-01'},
  ]);
  assert.equal(g.length,5);
  assert.ok(g[0].canPlot);assert.equal(g[0].points[0].value,0);assert.equal(g[0].distinctDates,2);
  assert.ok(g[1].canPlot);assert.equal(g[1].points.length,1);assert.equal(g[1].distinctDates,1);
  assert.equal(g[2].conflict,true);assert.ok(g[2].canPlot);assert.equal(g[2].points.length,3);assert.equal(g[2].records.length,3);assert.equal(g[2].distinctDates,2);
  assert.ok(g[3].canPlot);assert.equal(g[3].distinctDates,2);
  assert.ok(g[4].canPlot);assert.equal(g[4].points.length,1);assert.equal(g[4].distinctDates,1);
});
const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
test('patient chart opens a complete visual dashboard with interactive trends, timeline and source text', {skip:!existsSync(chrome)},async t=>{
  const f=await fixture(t);
  const p=(await f.json('/api/patients','POST',{
    name:'资料面板验收',gender:'female',note:'病史摘要：合成验收资料，用于核对面板展示。\n既往治疗及复诊资料已归档。',
    diagnoses:[{name:'合成诊断待核对',date:'2026-01-01',source:'病史.txt 第1行'}],
    medications:[{name:'合成用药A',status:'active',dose:'1片',frequency:'每日一次',source:'病史.txt 第2行'},{name:'合成用药B',status:'stopped'}],
    labs:[{item:'验收指标',value:0,unit:'U/L',date:'2026-01-01',source:'报告.txt 第1行'},{item:'验收指标',value:5,unit:'U/L',date:'2026-02-01'},{item:'验收指标',value:8,unit:'mg/L',date:'2026-02-01'}, {item:'冲突指标',value:1,unit:'U/L',date:'2026-01-01'},{item:'冲突指标',value:2,unit:'U/L',date:'2026-01-01'}],
    visits:[{date:'2026-01-01',reason:'初次就诊',note:'合成首次记录'},{date:'2026-02-01',reason:'复诊核对',note:'合成复诊记录'}],
  })).data;
  assert.ok(p.id);
  await f.json(`/api/sessions/${p.sessionId}/files`,'POST',{name:'报告.txt',text:'原始报告验收文字，数值 0 U/L。'});
  const browser=await chromium.launch({executablePath:chrome,headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:1100}});page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(f.origin);await page.getByRole('navigation',{name:'主要业务'}).getByRole('button',{name:'患者',exact:true}).click();
  await page.locator('.patient-card').filter({hasText:'资料面板验收'}).click();
  const panel=page.getByRole('region',{name:'患者资料面板'});
  await panel.getByRole('heading',{name:'患者概览'}).waitFor();
  assert.equal(await panel.locator('.chart-history').count(),0);
  const tabs=page.getByRole('navigation',{name:'患者栏目'});
  await tabs.getByRole('button',{name:'诊断与病史',exact:true}).click();
  assert.doesNotMatch(await panel.locator('.clinical-summary-text').allTextContents().then(a=>a.join('')),/病史摘要：合成验收资料/);
  await tabs.getByRole('button',{name:'资料核对',exact:true}).click();
  assert.match(await panel.innerText(),/病史摘要：合成验收资料/);
  await tabs.getByRole('button',{name:'检验趋势',exact:true}).click();
  await panel.getByRole('img',{name:'验收指标 U/L 检验趋势，2 次记录'}).waitFor();
  assert.equal(await panel.getByLabel('查看检验项目').count(),0);
  assert.equal(await panel.getByRole('img',{name:/检验趋势/}).count(),3);
  const primary = panel.getByRole('article',{name:'验收指标 U/L',exact:true});
  const otherUnit = panel.getByRole('article',{name:'验收指标 mg/L',exact:true});
  const conflict = panel.getByRole('article',{name:'冲突指标 U/L',exact:true});
  await otherUnit.getByText(/还连不成趋势线/).waitFor();
  await conflict.getByRole('button',{name:'查看数值冲突'}).click();
  assert.match(await panel.getByRole('region',{name:'检验数值冲突'}).innerText(),/冲突指标/);
  await tabs.getByRole('button',{name:'检验趋势',exact:true}).click();
  await conflict.getByText('全部记录与来源 · 2 条').click();
  assert.equal(await conflict.getByRole('table').locator('tbody tr').count(),2);
  assert.match(await panel.locator('.chart-lab-comparison').innerText(),/0/);
  await primary.getByRole('button',{name:'排在最前'}).click();
  await page.waitForFunction(()=>document.querySelector('.chart-lab-card')?.getAttribute('aria-label')==='验收指标 U/L');
  await otherUnit.getByRole('button',{name:'移出对照'}).click();
  await otherUnit.getByRole('button',{name:'加入对照'}).waitFor();
  await otherUnit.getByRole('button',{name:'折叠趋势'}).click();
  await otherUnit.getByRole('button',{name:'展开趋势'}).waitFor();
  await conflict.getByRole('button',{name:'隐藏',exact:true}).click();
  await panel.getByText('已隐藏 1 项检验 · 展开后可恢复').waitFor();
  assert.equal(await panel.getByRole('img',{name:/检验趋势/}).count(),1);
  await tabs.getByRole('button',{name:'就诊经过',exact:true}).click();
  assert.deepEqual(await panel.getByRole('region',{name:'就诊时间轴'}).locator('time').allTextContents(),['2026-02-01','2026-01-01']);
  await tabs.getByRole('button',{name:'资料库',exact:true}).click();
  const library=panel.getByRole('region',{name:'资料库'});
  await library.getByText('报告.txt',{exact:true}).click();await library.getByText('查看文字内容',{exact:true}).click();
  await library.getByText('原始报告验收文字，数值 0 U/L。',{exact:true}).waitFor();
  await library.getByLabel('查找文件').fill('不存在');await library.getByText('没有匹配的文件。').waitFor();
  await library.getByLabel('查找文件').fill('');
  await tabs.getByRole('button',{name:'检验趋势',exact:true}).click();
  await otherUnit.getByRole('button',{name:'展开趋势'}).waitFor();
  await panel.getByText('已隐藏 1 项检验 · 展开后可恢复').click();
  await panel.getByRole('button',{name:'恢复展示'}).click();
  await conflict.waitFor();
  await panel.getByRole('heading',{name:'检验趋势',exact:true}).scrollIntoViewIfNeeded();
  await panel.screenshot({path:'output/patient-dashboard-desktop.png'});
  await page.setViewportSize({width:820,height:1000});
  assert.ok(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
  await panel.screenshot({path:'output/patient-dashboard-narrow.png'});
  await panel.getByRole('button',{name:'核对与编辑'}).click();
  await page.getByRole('button',{name:'概览',exact:true}).click();await panel.waitFor();
  await tabs.getByRole('button',{name:'检验趋势',exact:true}).click();
  await panel.getByRole('button',{name:'和 AI 调整展示',exact:true}).click();
  const composer = page.getByRole('textbox',{name:'医疗工作需求',exact:true});
  await composer.waitFor();
  await page.waitForFunction(id => document.querySelector('textarea[aria-label="医疗工作需求"]')?.value.includes(id),p.id);
  assert.match(await composer.inputValue(),new RegExp(p.id));
  assert.match(await composer.inputValue(),/检验趋势展示习惯/);
  assert.deepEqual(errors,[]);
});

test('lab layout prioritizes monitored/conflicting/repeated groups and obeys saved choices', () => {
  const labs = [
    { item: 'A', value: 1, unit: 'U', date: '2026-01-01' },
    { item: 'B', value: 2, unit: 'U', date: '2026-01-01' },
    { item: 'B', value: 3, unit: 'U', date: '2026-02-01' },
    { item: 'C', value: 3, unit: 'U', date: '2026-01-01' },
  ];
  const key = item => JSON.stringify([item, 'U']);
  assert.deepEqual(dashboardLabLayout(labs, {}, [{item:'C',status:'active'}]).visible.map(g=>g.item), ['C','B','A']);
  const layout = dashboardLabLayout(labs, {order:[key('A')],hidden:[key('C')],collapsed:[key('B')],compare:[key('A'),key('C')]});
  assert.deepEqual(layout.visible.map(g=>g.item), ['A','B']);
  assert.deepEqual(layout.comparison.map(g=>g.item), ['A']);
  assert.ok(layout.collapsed.has(key('B')));
  assert.equal(dashboardLabLayout(labs,{compare:[]}).comparison.length,0);
  assert.equal(labs.length,4);
});
