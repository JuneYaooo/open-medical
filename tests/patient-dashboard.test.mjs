import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { dashboardLabGroups } from '../shared/patient-dashboard.mjs';
import { fixture } from './helpers.mjs';

test('lab visualization keeps units separate, preserves zero and disables ambiguous or incomplete trends',()=>{
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
  assert.equal(g.length,5);assert.ok(g[0].canPlot);assert.equal(g[0].points[0].value,0);
  assert.equal(g[1].canPlot,false);assert.equal(g[2].conflict,true);assert.equal(g[2].canPlot,false);
  assert.equal(g[2].records.length,3);assert.equal(g[3].canPlot,false);assert.equal(g[4].canPlot,false);
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
  const page=await browser.newPage({viewport:{width:1440,height:1100}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(f.origin);await page.getByRole('navigation',{name:'主要业务'}).getByRole('button',{name:'患者',exact:true}).click();
  await page.locator('.patient-card').filter({hasText:'资料面板验收'}).click();
  const panel=page.getByRole('region',{name:'患者资料面板'});
  await panel.getByRole('heading',{name:'患者资料总览'}).waitFor();
  assert.doesNotMatch(await panel.locator(".chart-history").innerText(),/病史摘要：合成验收资料/);
  await panel.getByText("资料备注与待核对信息",{exact:true}).click();
  assert.match(await panel.innerText(),/病史摘要：合成验收资料/);
  await panel.getByRole('img',{name:'验收指标 U/L 检验趋势，2 次记录'}).waitFor();
  const table=panel.getByRole('table');assert.match(await table.innerText(),/0/);
  const select=panel.getByLabel('查看检验项目');
  await select.selectOption(JSON.stringify(['验收指标','mg/L']));assert.equal(await panel.getByRole('img',{name:/检验趋势/}).count(),0);
  assert.match(await panel.getByRole('table').innerText(),/8/);
  await select.selectOption(JSON.stringify(['冲突指标','U/L']));
  await panel.getByText('同日存在不同数值，暂不连线，请核对下方记录及来源。').waitFor();
  assert.equal(await panel.getByRole('table').locator('tbody tr').count(),2);
  assert.deepEqual(await panel.getByRole('region',{name:'就诊时间轴'}).locator('time').allTextContents(),['2026-02-01','2026-01-01']);
  const source=panel.getByRole('region',{name:'档案来源资料'});
  await source.getByText('报告.txt',{exact:true}).click();await source.getByText('查看文字内容',{exact:true}).click();
  await source.getByText('原始报告验收文字，数值 0 U/L。',{exact:true}).waitFor();
  await source.getByLabel('查找文件').fill('不存在');await source.getByText('没有匹配的文件。').waitFor();
  await source.getByLabel('查找文件').fill('');
  await select.selectOption(JSON.stringify(['验收指标','U/L']));
  await panel.getByRole('heading',{name:'患者资料总览'}).scrollIntoViewIfNeeded();
  await page.screenshot({path:'output/patient-dashboard-desktop.png',fullPage:true});
  await page.setViewportSize({width:820,height:1000});
  assert.ok(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
  await page.screenshot({path:'output/patient-dashboard-narrow.png',fullPage:true});
  await panel.getByRole('button',{name:'核对与编辑资料'}).click();
  await page.getByRole('button',{name:'概览',exact:true}).click();await panel.waitFor();
  assert.deepEqual(errors,[]);
});
