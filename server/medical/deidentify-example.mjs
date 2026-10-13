// Preserve relative clinical chronology while stripping cross-patient identifiers.
export function deidentifyExample(
  snapshot,
  identities = [snapshot],
  { relativeDates = true } = {},
) {
  const secrets = identities
    .flatMap((s) =>
      [
        "name",
        "phone",
        "patientNumber",
        "idNumber",
        "hospitalNumber",
        "birthDate",
        "dateOfBirth",
      ].map((k) => s?.[k]),
    )
    .filter((v) => String(v || "").length > 1)
    .map(String)
    .sort((a, b) => b.length - a.length);
  const dates =
    JSON.stringify(snapshot, (k, v) =>
      ["birthDate", "dateOfBirth"].includes(k) ? undefined : v,
    )
      .replace(
        /(?:出生日期|出生年月|生日)[:： ]*(?:19|20)\d{2}[-/年]\d{1,2}[-/月]\d{1,2}日?/g,
        "",
      )
      .match(/\b(?:19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/g) || [];
  const first = Math.min(
    ...dates.map((d) => Date.parse(d)).filter(Number.isFinite),
  );
  const clean = (text) => {
    let result = text;
    for (const secret of secrets) result = result.split(secret).join("某患者");
    return result
      .replace(
        /(?:出生日期|出生年月|生日)[:： ]*(?:19|20)\d{2}[-/年]\d{1,2}[-/月]\d{1,2}日?/g,
        "出生日期：已隐藏",
      )
      .replace(
        /(?:出生年|生于)[:： ]*((?:19|20)\d{2})年?/g,
        (_, year) =>
          `年龄：${Math.floor((new Date().getFullYear() - Number(year)) / 10) * 10}多岁`,
      )
      .replace(
        /(?:联系电话|电话|手机)[:： ]*[+\d()（） -]{5,}/g,
        "电话：已隐藏",
      )
      .replace(
        /(?:姓名|患者姓名|病人姓名)\s*[:：]\s*[^\s，。；,;\n]{1,30}/g,
        "姓名：某患者",
      )
      .replace(
        /(?:住院号|病案号|门诊号|身份证号?|证件号)\s*[:：]?\s*[A-Za-z0-9-]+/g,
        "编号已隐藏",
      )
      .replace(/\b\d{17}[\dXx]\b/g, "证件号已隐藏")
      .replace(/(?:\+?86[- ]?)?1[3-9]\d{9}\b/g, "电话已隐藏")
      .replace(/\b(?:19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/g, (d) => {
        if (!relativeDates) return d;
        const days = Math.round((Date.parse(d) - first) / 86400000);
        return Number.isFinite(days)
          ? relativeDates === "shifted"
            ? new Date(Date.UTC(2000, 0, 1) + days * 86400000)
                .toISOString()
                .slice(0, 10)
            : `首诊后${days}天`
          : "日期已隐藏";
      })
      .replace(/(?:19|20)\d{2}年\d{1,2}月\d{1,2}日/g, (d) =>
        relativeDates ? "日期已隐藏" : d,
      );
  };
  const visit = (value, key = "") => {
    if (
      [
        "name",
        "phone",
        "patientNumber",
        "idNumber",
        "hospitalNumber",
        "birthDate",
        "dateOfBirth",
      ].includes(key) &&
      value === snapshot[key]
    )
      return key === "name" ? "某患者" : "";
    if (typeof value === "string") return clean(value);
    if (Array.isArray(value)) return value.map((v) => visit(v));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(
            ([k]) =>
              ![
                "id",
                "sessionId",
                "sourceSessionId",
                "sourceFileIds",
                "sourceInput",
                "source",
                "sources",
                "personalization",
                "learningContext",
                "habitChanges",
                "preHabitPayload",
                "creationRequestId",
              ].includes(k),
          )
          .map(([k, v]) => [k, visit(v, k)]),
      );
    return value;
  };
  const result = visit(snapshot);
  if (snapshot.birthYear) {
    result.ageBand = `${Math.floor((new Date().getFullYear() - snapshot.birthYear) / 10) * 10}多岁`;
    delete result.birthYear;
  }
  return result;
}
