import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { fixture } from './helpers.mjs';
const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const output='output/playwright/audit-20260925';
const skip=!existsSync(chrome)||!existsSync('dist/index.html');
test('all navigation surfaces render on desktop and narrow screens with reachable content', {skip,timeout:120000}, async t=>{
  const f=await fixture(t),browser=await chromium.launch({executablePath:chrome,headless:true});
  t.after(()=>browser.close());
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const measurements=[];mkdirSync(output,{recursive:true});
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:900});
    for(const view of ['settings','home','patients','followups','research','knowledge','projects','tools','tasks','literature','clinical-ref','cases','drg','data-analysis','review','workspaces']){
      await page.goto(f.origin+'/?view='+view);
      await page.locator('.product-content h1,.product-content h2,.product-content h3').first().waitFor({timeout:10000});
      await page.getByRole('button',{name:'设置与连接',exact:true}).count();
      const layout=await page.evaluate(()=>({
        width:innerWidth,bodyWidth:document.documentElement.scrollWidth,
        unnamed:[...document.querySelectorAll('input,select,textarea')].filter(el=>el.getClientRects().length&&!['hidden','file'].includes(el.type)&&!el.labels?.length&&!el.getAttribute('aria-label')&&!el.getAttribute('aria-labelledby')&&!el.title).map(el=>({tag:el.tagName,type:el.type,placeholder:el.placeholder||'',text:el.tagName==='SELECT'?el.options[0]?.text:''})),
        skipTarget:!!document.querySelector(document.querySelector('.skip-link').hash),
      }));
      measurements.push({view,...layout});
      writeFileSync(`${output}/surface-audit.json`,JSON.stringify(measurements,null,2));
      await page.screenshot({path:`${output}/surface-${view}-${width}.png`});
      assert.ok(layout.skipTarget,view+' missing skip-link target');
      assert.deepEqual(layout.unnamed,[],view+' has unnamed visible inputs');
      assert.ok(layout.bodyWidth<=width+1,`${view} overflow at ${width}: ${layout.bodyWidth}`);
      await page.screenshot({path:`${output}/surface-${view}-${width}.png`});
    }
  }
  writeFileSync(`${output}/surface-audit.json`,JSON.stringify(measurements,null,2));
  assert.deepEqual(errors,[]);
});
