import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const exec = promisify(execFile),
  python = process.env.TEST_OFFICE_PYTHON;
test(
  "structured Office layouts round-trip tables, formatting, charts, notes and PDF text",
  { skip: !python },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "office-layout-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const content = {
      title: "排版验收",
      header: "HEADER",
      footer: "FOOTER",
      blocks: [
        { type: "heading", text: "结构化报告" },
        {
          type: "paragraph",
          runs: [{ text: "重点", bold: true }, { text: " normal" }],
        },
        {
          type: "table",
          rows: [
            ["项目", "金额"],
            ["Alpha", 12],
            ["Beta", 24],
          ],
        },
        { type: "pageBreak" },
        { type: "paragraph", text: "第二页" },
      ],
      sheets: [
        {
          name: "Data",
          rows: [
            ["项目", "金额"],
            ["Alpha", 12],
            ["Beta", 24],
            ["Total", "=SUM(B2:B3)"],
          ],
          table: true,
          widths: { A: 22, B: 16 },
          formats: { "B2:B4": "0.00" },
          charts: [
            {
              type: "bar",
              title: "金额",
              data: "B1:B3",
              categories: "A2:A3",
              anchor: "D2",
            },
          ],
        },
      ],
      slides: [
        {
          title: "报告",
          notes: "讲稿备注",
          elements: [
            {
              type: "table",
              rows: [
                ["项目", "金额"],
                ["Alpha", 12],
              ],
              x: 0.7,
              y: 1.5,
              width: 5,
              height: 2,
            },
            {
              type: "chart",
              chartType: "bar",
              categories: ["Alpha", "Beta"],
              series: [{ name: "金额", values: [12, 24] }],
              x: 7,
              y: 1.5,
              width: 5,
              height: 4,
            },
          ],
        },
      ],
    };
    for (const kind of ["docx", "xlsx", "pptx", "pdf"]) {
      const result = await exec(
        python,
        [
          resolve("desktop/full-runtime/document.py"),
          "--base64",
          Buffer.from(
            JSON.stringify({
              action: "create",
              path: "report." + kind,
              content,
            }),
          ).toString("base64"),
        ],
        { cwd: directory },
      );
      assert.ok(JSON.parse(result.stdout).result.bytes > 100);
    }
    const verification = `from docx import Document
from openpyxl import load_workbook
from pptx import Presentation
from pypdf import PdfReader
d=Document('report.docx'); assert len(d.tables)==1; assert d.tables[0].cell(1,0).text=='Alpha'; assert d.sections[0].header.paragraphs[0].text=='HEADER'; assert any(r.bold for p in d.paragraphs for r in p.runs)
w=load_workbook('report.xlsx'); assert w['Data']['B4'].value=='=SUM(B2:B3)'; assert w['Data']['B2'].number_format=='0.00'; assert len(w['Data']._charts)==1
p=Presentation('report.pptx'); assert p.slides[0].notes_slide.notes_text_frame.text=='讲稿备注'; assert any(s.has_chart for s in p.slides[0].shapes)
pdf=PdfReader('report.pdf'); assert len(pdf.pages)==2; assert 'Alpha' in pdf.pages[0].extract_text(); assert 'FOOTER' in pdf.pages[1].extract_text()
print('layout verified')`;
    writeFileSync(join(directory, "verify.py"), verification);
    assert.match(
      (await exec(python, ["verify.py"], { cwd: directory })).stdout,
      /layout verified/,
    );
  },
);
