// A normal clinical answer may contain a table without creating a file. Only
// explicit requests for a saved deliverable require a current-run receipt.
export function requestsMedicalDeliverable(message = '') {
  return /(?:生成|创建|制作|导出|下载|保存|写入).{0,16}(?:文件|文档|报告|核对表|清单文件|Word|PDF|Excel|DOCX|XLSX)|(?:文件|文档|报告|核对表).{0,12}(?:生成|导出|下载|保存)|(?:export|create|save|download).{0,30}(?:file|document|report|pdf|docx|xlsx)/i.test(message);
}
