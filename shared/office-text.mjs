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
    await workbook.xlsx.load(bytes);
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
