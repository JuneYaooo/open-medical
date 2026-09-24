// Extract data only: never execute Office macros, formulas or external links.
export async function extractOfficeText(bytes, name) {
  if (!bytes.byteLength) throw new Error("文件为空（0 字节），请检查原文件");
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('Office 文件超过 20MB，请拆分后导入');
  let text;
  if (/\.docx$/i.test(name)) {
    const { default: mammoth } = await import('mammoth/mammoth.browser.js');
    const result = await mammoth.extractRawText({ arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    text = result.value;
  } else {
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await normalizeSpreadsheetNotes(bytes));
    const lines = [];
    let chars = 0;
    workbook.eachSheet((sheet) => {
      lines.push(`[工作表：${sheet.name}]`);
      sheet.eachRow((row, number) => {
        const cells = [];
        row.eachCell((cell) => {
          const v = cell.value;
          let value = cell.text;
          if (v && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v)) value = v.result === undefined ? '[公式无缓存结果，未计算]' : String(v.result);
          if (v instanceof Date) value = v.toISOString();
          cells.push(`${cell.address}=${value}`);
        });
        const line = `行 ${number}: ${cells.join(' | ')}`;
        chars += line.length;
        if (chars > 400000) throw new Error('表格文本超过 400000 字符，请拆分后导入');
        lines.push(line);
      });
    });
    text = lines.join('\n');
  }
  if (!text.trim()) throw new Error('文档没有可提取文字；图片型 Word 请将图片单独上传');
  if (text.length > 400000) throw new Error('文档文本超过 400000 字符，请拆分后导入');
  return { text, extraction: { type: /\.docx$/i.test(name) ? 'docx_text' : 'xlsx_text', originalRetained: false } };
}

// ExcelJS expects specific comment/VML part names and relative targets. Other
// producers use valid absolute targets and nested part names. Normalize only
// an in-memory copy; preserve the original file and the comment contents.
async function normalizeSpreadsheetNotes(bytes) {
  const [{ default: JSZip }, { XMLParser, XMLBuilder }] = await Promise.all([
    import('jszip'), import('fast-xml-parser'),
  ]);
  const zip = await JSZip.loadAsync(bytes);
  const options = { ignoreAttributes: false, attributeNamePrefix: '@_' };
  const parser = new XMLParser(options), builder = new XMLBuilder(options);
  let changed = false, index = 0;
  for (const entry of Object.values(zip.files)) {
    if (!/^xl\/worksheets\/_rels\/[^/]+\.rels$/.test(entry.name)) continue;
    const document = parser.parse(await entry.async('string'));
    const relationships = document.Relationships?.Relationship;
    for (const relation of [relationships].flat().filter(Boolean)) {
      const type = relation['@_Type']?.split('/').at(-1);
      if (!['comments', 'vmlDrawing'].includes(type) || relation['@_TargetMode'] === 'External') continue;
      const target = relation['@_Target'];
      const parts = [];
      for (const part of (target.startsWith('/') ? target : 'xl/worksheets/' + target).split('/')) {
        if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part);
      }
      const original = zip.file(parts.join('/'));
      if (!original) throw new Error('表格批注引用的文件缺失，请用表格软件重新保存后上传');
      // Allocate unused canonical names so existing parts cannot be overwritten.
      let name;
      do { index++; name = type === 'comments' ? `xl/comments${index}.xml` : `xl/drawings/vmlDrawing${index}.vml`; } while (zip.file(name));
      zip.file(name, await original.async('uint8array'));
      relation['@_Target'] = '../' + name.slice(3);
      changed = true;
    }
    if (relationships) zip.file(entry.name, builder.build(document));
  }
  return changed ? zip.generateAsync({ type: 'uint8array' }) : bytes;
}
