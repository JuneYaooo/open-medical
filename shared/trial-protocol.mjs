// Only split unambiguous, single-cohort headings. Nested clauses stay attached
// to their parent condition; missing headings require the doctor's review.
export function splitEligibility(text = "") {
  const headings = [
    ...text.matchAll(
      /^\s*(?:#{1,6}\s*)?(Inclusion Criteria|Exclusion Criteria|入选标准|纳入标准|入选条件|纳入条件|排除标准|排除条件)\s*[:：]?\s*$/gim,
    ),
  ];
  if (
    headings.length !== 2 ||
    !/^(?:inclusion criteria|入选标准|纳入标准|入选条件|纳入条件)$/i.test(headings[0][1]) ||
    !/^(?:exclusion criteria|排除标准|排除条件)$/i.test(headings[1][1]) ||
    /(?:inclusion|exclusion) criteria\s+(?:for|of)/i.test(text)
  )
    return {
      inclusion: "",
      exclusion: "",
      criteriaNotice:
        "筛选标准包含分组或非标准标题，请结合原文整理，未自动拆分。",
    };
  const sections = [
    text.slice(headings[0].index + headings[0][0].length, headings[1].index),
    text.slice(headings[1].index + headings[1][0].length),
  ];
  const rows = sections.map((section) => {
    const lines = section.trim().split("\n"),
      result = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      if (/^(?:[-*]\s+|\d+[.)、．]\s*)/.test(line) || !result.length)
        result.push(line.trim());
      else result[result.length - 1] += " " + line.trim();
    }
    return result.join("\n");
  });
  return {
    inclusion: rows[0],
    exclusion: rows[1],
    criteriaNotice: "已按原文标题整理。请核对逻辑、分组、阈值及时间窗后保存。",
  };
}
