import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import ExcelJS from 'exceljs';
import { fixture } from './helpers.mjs';
import { syntheticPdf } from './fixtures/make-pdf.mjs';
import { writeZip } from '../scripts/eval-v1/lib/zip.mjs';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('browser attachments: image, scanned/text PDF, DOCX, XLSX, TXT, MD and JSON survive material view and reload', {skip:!existsSync(chrome)||!existsSync('dist/index.html')}, async(t)=>{
  const f=await fixture(t);
  const browser=await chromium.launch({executablePath:chrome,headless:true}); t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(f.origin + "/?view=home");
  await page.locator(".advanced-nav>summary").click();
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'附件',exact:true}).click();
  const book=new ExcelJS.Workbook();book.addWorksheet('检验').addRow(['synthetic Hb',100]);
  const docx=writeZip(new Map([
    ['[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>合成患者病史 2026-09-20</w:t></w:r></w:p></w:body></w:document>'],
  ]));
  const image=await page.screenshot();
  await (await chooser).setFiles([
    {name:'sample.png',mimeType:'image/png',buffer:image},
    {name:'history.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:docx},
    {name:'labs.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(await book.xlsx.writeBuffer())},
    {name:'text.pdf',mimeType:'application/pdf',buffer:syntheticPdf()},
    {name:'scan.pdf',mimeType:'application/pdf',buffer:syntheticPdf([])},
    ...['txt','md','json'].map(ext=>({name:`record.${ext}`,mimeType:'text/plain',buffer:Buffer.from(`synthetic ${ext} material`)})),
  ]);
  await page.getByText('已附加 8 份材料，将随本次任务一起发送。Enter 发送 · Shift + Enter 换行').waitFor({timeout:60000});
  const sessions=(await f.json('/api/sessions')).data.sessions;
  assert.equal(sessions.length,1);
  const session=(await f.json(`/api/sessions/${sessions[0].id}`)).data;
  assert.equal(session.files.length,8);
  assert.ok(session.files.find(f=>f.name==='history.docx').text.includes('合成患者'));
  assert.ok(session.files.find(f=>f.name==='labs.xlsx').text.includes('A1=synthetic Hb'));
  assert.equal(session.files.find(f=>f.name==='scan.pdf').extraction.pageImages.length,1);
  await page.locator('nav[aria-label="最近任务"] button').first().click();
  await page.getByRole('button',{name:/材料/}).first().click();
  await page.getByRole('button',{name:'查看资料',exact:true}).click();
 await page.getByText('图片 · 已保存原图 · 可本地 OCR / 视觉读取').waitFor();
  await page.getByText('查看原图',{exact:true}).click();
  await page.locator('img[alt="sample.png"]').waitFor();
  assert.ok(await page.locator('img[alt="sample.png"]').evaluate(img=>img.complete && img.naturalWidth>0));
  await page.reload();
 await page.locator(".advanced-nav>summary").click();
  await page.locator('nav[aria-label="最近任务"] button').first().click();
  await page.getByRole('button',{name:/材料/}).first().click();
  await page.getByRole('button',{name:'查看资料',exact:true}).click();
  await page.getByText('Word 抽取文本 · 未保存原件').waitFor();
  assert.deepEqual(errors,[]);
  mkdirSync('output/playwright',{recursive:true});
  await page.screenshot({path:'output/playwright/material-intake.png',fullPage:true});
});

test('supplied real PDF uploads through browser and its scanned pages are readable with local OCR', {skip:!process.env.MEDICAL_INTAKE_PDF||!existsSync(chrome)}, async(t)=>{
  const f=await fixture(t),browser=await chromium.launch({executablePath:chrome,headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();await page.goto(f.origin + "/?view=home");
  await page.locator(".advanced-nav>summary").click();
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'附件',exact:true}).click();
  await(await chooser).setFiles(process.env.MEDICAL_INTAKE_PDF);
  await page.getByText('已附加 1 份材料，将随本次任务一起发送。Enter 发送 · Shift + Enter 换行').waitFor({timeout:60000});
  const sessions=(await f.json('/api/sessions')).data.sessions;
  const session=(await f.json(`/api/sessions/${sessions[0].id}`)).data;
  assert.equal(session.files.length,1);
  const file=session.files[0];assert.ok(file.extraction.pageCount>0);
  if(file.extraction.pageImages?.length){
    const {recognizeImage}=await import('../server/core/image-ocr.mjs');
    const image=f.server.workspaces.artifacts.read(session.id,file.extraction.pageImages[0].artifactId);
    const result=await recognizeImage(image.data);assert.ok(result.lines.length>3);
    t.diagnostic(JSON.stringify({pages:file.extraction.pageCount,scannedPages:file.extraction.pageImages.length,ocrLines:result.lines.length}));
  }else assert.ok(file.text.length>100);
});
