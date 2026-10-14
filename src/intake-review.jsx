import { useEffect, useImperativeHandle, useRef, useState } from "react";
import { api } from "./agent-runtime";
import {
  alignReviewItems,
  reviewDiff,
  reviewCounts,
} from "../shared/review-diff.mjs";
import "./intake-review.css";
const DELETE_REASONS = ["资料里没有", "重复", "不该算诊断", "不重要", "其他"];
const labels = {
  diagnoses: "诊断与问题",
  medications: "用药",
  labs: "检验",
  visits: "就诊经历",
  allergies: "过敏原",
  groups: "分组",
  tags: "标签",
};
const fields = {
  identity: [
    ["name", "姓名", "text", true, 80],
    ["gender", "性别", ["male:男", "female:女", "unknown:待补充"]],
    ["birthYear", "出生年", "number"],
    ["phone", "电话", "text", false, 20],
  ],
  diagnoses: [
    ["name", "诊断名称", "text", true, 120],
    [
      "status",
      "诊断状态",
      [
        "confirmed:确诊",
        "suspected:疑似待排",
        "finding:影像检验发现",
        "needs_review:待核对",
      ],
    ],
    ["date", "诊断日期", "date"],
    ["note", "备注", "textarea", false, 300],
  ],
  medications: [
    ["name", "药名", "text", true, 120],
    ["dose", "剂量", "text", false, 60],
    ["frequency", "频次", "text", false, 60],
    [
      "status",
      "用药状态",
      ["active:正在使用", "stopped:已停用", "unknown:待核对"],
    ],
    ["note", "备注", "textarea", false, 500],
  ],
  labs: [
    ["date", "检验日期", "date", true],
    ["item", "检验项目", "text", true, 60],
    ["value", "检验数值", "number", true],
    ["unit", "单位", "text", false, 30],
    ["note", "备注", "textarea", false, 500],
  ],
  visits: [
    ["date", "就诊日期", "date", true],
    ["reason", "就诊事由", "text", true, 200],
    ["note", "备注", "textarea", false, 500],
  ],
  clinicalSummary: [["text", "病史摘要正文", "textarea", true, 4000]],
};
const statusText = {
  male: "男",
  female: "女",
  unknown: "待核对",
  confirmed: "确诊",
  suspected: "疑似待排",
  finding: "影像检验发现",
  needs_review: "待核对",
  active: "正在使用",
  stopped: "已停用",
};
const describe = (item) =>
  typeof item === "string"
    ? item
    : [
        "date",
        "name",
        "item",
        "reason",
        "value",
        "unit",
        "dose",
        "frequency",
        "status",
        "note",
      ]
        .map((k) => (k === "status" ? statusText[item[k]] : item[k]))
        .filter((v) => v !== undefined && v !== "")
        .join(" · ");
function ItemForm({ section, value, onSave, onCancel }) {
  const [draft, setDraft] = useState(
    typeof value === "string" ? { text: value } : value || {},
  );
  const definitions = fields[section] || [
    ["text", labels[section], "text", true, section === "allergies" ? 120 : 40],
  ];
  const issues = {};
  for (const [key, label, type, required, max] of definitions) {
    const v = draft[key];
    if (
      required &&
      (v === undefined || v === "" || (typeof v === "string" && !v.trim()))
    )
      issues[key] = `${label}不能为空`;
    else if (
      v != null &&
      v !== "" &&
      type === "number" &&
      (!Number.isFinite(Number(v)) ||
        (key === "birthYear" &&
          (!Number.isInteger(Number(v)) ||
            Number(v) < 1900 ||
            Number(v) > new Date().getFullYear())))
    )
      issues[key] = `${label}无效`;
    else if (
      v &&
      type === "date" &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(v) ||
        !Number.isFinite(Date.parse(v)) ||
        new Date(v).toISOString().slice(0, 10) !== v)
    )
      issues[key] = "日期须为 YYYY-MM-DD";
    else if (max && String(v || "").length > max)
      issues[key] = `最多 ${max} 字`;
  }
  const save = () => {
    if (Object.keys(issues).length) return;
    const next = { ...draft };
    for (const [key, , type] of definitions)
      if (type === "number")
        next[key] =
          next[key] === "" || next[key] == null ? null : Number(next[key]);
    onSave(fields[section] ? next : next.text.trim());
  };
  return (
    <div
      className="review-form"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
        if (
          e.key === "Enter" &&
          e.target.tagName !== "TEXTAREA" &&
          e.target.tagName !== "BUTTON"
        ) {
          e.preventDefault();
          save();
        }
      }}
    >
      {definitions.map(([key, label, type, , max], i) => (
        <label key={key}>
          {label}
          {Array.isArray(type) ? (
            <select
              aria-label={label}
              value={draft[key] || ""}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            >
              <option value="">待补充</option>
              {type.map((v) => {
                const [id, text] = v.split(":");
                return (
                  <option key={id} value={id}>
                    {text}
                  </option>
                );
              })}
            </select>
          ) : type === "textarea" ? (
            <textarea
              autoFocus={i === 0}
              aria-label={label}
              value={draft[key] || ""}
              maxLength={max}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            />
          ) : (
            <input
              autoFocus={i === 0}
              aria-label={label}
              type={type}
              step={type === "number" ? "any" : undefined}
              value={draft[key] ?? ""}
              maxLength={max}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            />
          )}
          {issues[key] && <small className="error-text">{issues[key]}</small>}
        </label>
      ))}
      <div className="toolbar-actions">
        <button
          className="primary"
          disabled={!!Object.keys(issues).length}
          onClick={save}
        >
          保存
        </button>
        <button className="secondary" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
export function IntakeReview({ action, ref, onChange, onEditing }) {
  const original = action.payload;
  const [payload, setPayload] = useState(
    action.reviewDraft?.payload || original,
  );
  const [reasons, setReasons] = useState(action.reviewDraft?.reasons || {});
  const [editing, setEditing] = useState(null),
    [saveStatus, setSaveStatus] = useState(""),
    [resetConfirm, setResetConfirm] = useState(false),
    [expandedLabs, setExpandedLabs] = useState(false);
  const opened = useRef(Date.now()),
    revision = useRef(action.reviewRevision || 0),
    latest = useRef({ payload, reasons }),
    timer = useRef(null),
    chain = useRef(Promise.resolve()),
    version = useRef(0),
    persisted = useRef(0),
    alive = useRef(true);
  const diffs = reviewDiff(original, payload, { reasons }),
    counts = reviewCounts(original, diffs);
  const persist = () => {
    clearTimeout(timer.current);
    const at = version.current,
      snapshot = latest.current;
    if (at === persisted.current) return chain.current;
    const run = async () => {
      if (at <= persisted.current) return;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const saved = await api(
            `/api/pending-actions/${action.id}/review-draft`,
            "PATCH",
            { ...snapshot, expectedRevision: revision.current },
          );
          revision.current = saved.reviewRevision;
          persisted.current = at;
          if (alive.current && at === version.current)
            setSaveStatus("修改已保存");
          return;
        } catch (error) {
          if (alive.current)
            setSaveStatus(`修改暂未保存到本机，请勿关闭窗口：${error.message}`);
          if (attempt === 3 || error.status === 409 || error.status === 400)
            throw error;
          await new Promise((resolve) =>
            setTimeout(resolve, 400 * (attempt + 1)),
          );
        }
      }
    };
    chain.current = chain.current.catch(() => {}).then(run);
    return chain.current;
  };
  const change = (next, nextReasons = reasons) => {
    latest.current = { payload: next, reasons: nextReasons };
    version.current++;
    setPayload(next);
    setReasons(nextReasons);
    setSaveStatus("正在保存…");
    onChange?.({
      ...latest.current,
      count: reviewCounts(original, reviewDiff(original, next)).total,
    });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => persist().catch(() => {}), 600);
  };
  useImperativeHandle(ref, () => ({
    flush: persist,
    value: () => ({
      ...latest.current,
      reviewMs: Date.now() - opened.current,
      expectedRevision: revision.current,
    }),
    count: counts.total,
    editing: Boolean(editing),
  }));
  useEffect(() => {
    alive.current = true;
    onChange?.({ ...latest.current, count: counts.total });
    const unload = (e) => {
      if (version.current !== persisted.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
      persist().catch(() => {});
      window.removeEventListener("beforeunload", unload);
    };
  }, []);
  useEffect(() => {
    onEditing?.(Boolean(editing));
  }, [editing]);
  const saveEditor = (value) => {
    const { section, index } = editing;
    if (section === "identity") change({ ...payload, ...value });
    else if (section === "clinicalSummary")
      change({
        ...payload,
        clinicalSummary: {
          ...value,
          source:
            original.clinicalSummary?.source ||
            (original.clinicalSummary?.text ? "" : "医生补充"),
        },
      });
    else {
      const list = [...(payload[section] || [])];
      if (index === null) list.push(value);
      else list[index] = value;
      change({
        ...payload,
        [section]: list,
        ...(section === "allergies"
          ? { allergyStatus: list.length ? "recorded" : "unknown" }
          : {}),
      });
    }
    setEditing(null);
  };
  const editForm = (section) =>
    editing?.section === section && (
      <ItemForm
        key={`${section}:${editing.index}`}
        section={section}
        value={editing.value}
        onSave={saveEditor}
        onCancel={() => setEditing(null)}
      />
    );
  return (
    <div className="intake-review">
      <div className="review-heading">
        <h3>核对建档草稿</h3>
        {counts.total > 0 && <span>已改 {counts.total} 处</span>}
        {counts.total > 0 && (
          <button className="text-button" onClick={() => setResetConfirm(true)}>
            全部还原
          </button>
        )}
      </div>
      {resetConfirm && (
        <div role="alert">
          <p>放弃你做的 {counts.total} 处修改？</p>
          <button
            onClick={() => {
              change(structuredClone(original), {});
              setEditing(null);
              setResetConfirm(false);
            }}
          >
            放弃修改并还原
          </button>
          <button className="secondary" onClick={() => setResetConfirm(false)}>
            继续核对
          </button>
        </div>
      )}
      {action.reviewDraft && (
        <p className="muted">
          已恢复你上次的{" "}
          {
            reviewCounts(
              original,
              reviewDiff(original, action.reviewDraft.payload),
            ).total
          }{" "}
          处修改
        </p>
      )}
      {saveStatus && (
        <p
          role="status"
          className={
            saveStatus.includes("暂未") ? "review-save-warning" : "muted"
          }
        >
          {saveStatus}
        </p>
      )}
      <section aria-label="身份信息" className="review-row">
        <p>
          <b>{payload.name}</b> · {statusText[payload.gender] || "性别待补充"}
          {payload.birthYear ? ` · ${payload.birthYear} 年生` : ""}
          {payload.phone ? ` · ${payload.phone}` : ""}
        </p>
        <button
          className="text-button"
          onClick={() =>
            setEditing({
              section: "identity",
              value: Object.fromEntries(
                fields.identity.map(([k]) => [k, payload[k]]),
              ),
            })
          }
        >
          编辑身份信息
        </button>
        {diffs.some((d) => d.section === "identity") && (
          <button
            className="text-button"
            onClick={() =>
              change({
                ...payload,
                ...Object.fromEntries(
                  fields.identity.map(([k]) => [k, original[k]]),
                ),
              })
            }
          >
            还原身份信息
          </button>
        )}
        {editForm("identity")}
      </section>
      <section>
        <h4>病史摘要</h4>
        <p className="review-summary">
          {payload.clinicalSummary?.text || "待补充"}
        </p>
        <small>来源：{payload.clinicalSummary?.source || "待核对出处"}</small>
        <button
          className="text-button"
          onClick={() =>
            setEditing({
              section: "clinicalSummary",
              value: payload.clinicalSummary || {},
            })
          }
        >
          编辑病史摘要
        </button>
        {diffs.some((d) => d.section === "clinicalSummary") && (
          <button
            title={`AI 原文：${original.clinicalSummary?.text || ""}`}
            onClick={() =>
              change({ ...payload, clinicalSummary: original.clinicalSummary })
            }
          >
            已改 ↺
          </button>
        )}
        {editForm("clinicalSummary")}
      </section>
      {Object.entries(labels).map(([section, label]) => (
        <section
          key={section}
          aria-label={label}
          className={
            !(payload[section]?.length || original[section]?.length) &&
            editing?.section !== section
              ? "review-empty"
              : undefined
          }
        >
          <div className="review-heading">
            <h4>
              {label}（{payload[section]?.length || 0}）
            </h4>
            <button
              className="text-button"
              disabled={Boolean(editing)}
              onClick={() =>
                setEditing({
                  section,
                  index: null,
                  value: fields[section] ? {} : "",
                })
              }
            >
              添加{label}
            </button>
            {section === "allergies" && (
              <label className="review-allergy-status">
                过敏史
                <select
                  value={payload.allergyStatus || "unknown"}
                  onChange={(e) =>
                    change({ ...payload, allergyStatus: e.target.value })
                  }
                >
                  <option
                    value="unknown"
                    disabled={!!payload.allergies?.length}
                  >
                    待核对
                  </option>
                  <option
                    value="none_known"
                    disabled={!!payload.allergies?.length}
                  >
                    已核对无已知过敏
                  </option>
                  <option
                    value="recorded"
                    disabled={!payload.allergies?.length}
                  >
                    已记录过敏原
                  </option>
                </select>
              </label>
            )}
          </div>
          {alignReviewItems(
            section,
            original[section] || [],
            payload[section] || [],
          ).map(([i, j], n) => {
            if (
              section === "labs" &&
              n >= 5 &&
              !expandedLabs &&
              editing?.index !== j
            )
              return null;
            const before = i === null ? null : original[section][i],
              item = j === null ? before : payload[section][j];
            const changed = diffs.some(
              (d) =>
                d.section === section &&
                (i !== null ? d.beforeIndex === i : d.afterIndex === j),
            );
            const restore = () => {
              const list = [...(payload[section] || [])];
              if (j === null) list.splice(Math.min(i, list.length), 0, before);
              else if (i === null) list.splice(j, 1);
              else list[j] = before;
              const r = { ...reasons };
              delete r[`${section}:${i}`];
              change(
                {
                  ...payload,
                  [section]: list,
                  ...(section === "allergies"
                    ? {
                        allergyStatus: list.length
                          ? "recorded"
                          : original.allergyStatus || "unknown",
                      }
                    : {}),
                },
                r,
              );
            };
            const habitChips =
              j !== null &&
              (original.habitChanges || [])
                .filter(
                  (c) =>
                    c.section === section &&
                    (c.afterIndex ?? c.index) === i &&
                    c.after &&
                    (c.fields || Object.keys(c.after)).every(
                      (field) =>
                        JSON.stringify(item[field]) ===
                        JSON.stringify(c.after[field]),
                    ),
                )
                .map((c) => (
                  <button
                    className="review-habit"
                    title="点此还原为 AI 原文"
                    aria-label={`按习惯「${c.content}」改写，点此还原`}
                    key={c.habitId}
                    onClick={() => {
                      const list = [...payload[section]];
                      list[j] = {
                        ...list[j],
                        ...Object.fromEntries(
                          (c.fields || Object.keys(c.before)).map((field) => [
                            field,
                            c.before[field],
                          ]),
                        ),
                      };
                      change({ ...payload, [section]: list });
                    }}
                  >
                    按习惯：{c.content} ↺
                  </button>
                ));
            return (
              <div
                className={`review-item ${j === null ? "review-deleted" : ""}`}
                key={`${section}:${i ?? `new-${j}`}`}
              >
                <div className="review-item-main">
                  <p>
                    {describe(item)}
                    {habitChips}
                  </p>
                  {typeof item === "object" && (
                    <small>
                      来源：
                      {(item.sources?.length
                        ? item.sources
                        : [item.source].filter(Boolean)
                      ).join("；") || (i === null ? "医生补充" : "待核对出处")}
                    </small>
                  )}
                </div>
                <div className="review-item-actions">
                  {j !== null && (
                    <>
                      <button
                        className="text-button"
                        onClick={() =>
                          setEditing({ section, index: j, value: item })
                        }
                      >
                        改
                      </button>
                      <button
                        className="text-button"
                        onClick={() => {
                          const list = payload[section].filter(
                            (_, k) => k !== j,
                          );
                          change({
                            ...payload,
                            [section]: list,
                            ...(section === "allergies"
                              ? {
                                  allergyStatus: list.length
                                    ? "recorded"
                                    : "unknown",
                                }
                              : {}),
                          });
                        }}
                      >
                        {i === null ? "移除" : "删"}
                      </button>
                    </>
                  )}
                  {changed && (
                    <button
                      className="text-button"
                      title={`AI 原文：${before ? describe(before) : "无"}`}
                      onClick={restore}
                    >
                      {i === null
                        ? "你添加的 ×"
                        : j === null
                          ? "已删除 ↺"
                          : "已改 ↺"}
                    </button>
                  )}
                </div>
                {editing?.section === section &&
                  editing.index === j &&
                  j !== null &&
                  editForm(section)}
                {j === null && (
                  <div
                    className="review-reasons"
                    role="group"
                    aria-label={`${label}第${n + 1}条删除原因`}
                  >
                    <span>为什么删（可选）</span>
                    {DELETE_REASONS.map((r) => {
                      const key = `${section}:${i}`,
                        active = reasons[key] === r;
                      return (
                        <button
                          key={r}
                          type="button"
                          aria-pressed={active}
                          onClick={() =>
                            change(payload, {
                              ...reasons,
                              [key]: active ? "" : r,
                            })
                          }
                        >
                          {r}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {section === "labs" && (payload.labs?.length || 0) > 5 && (
            <button
              className="text-button"
              onClick={() => setExpandedLabs(!expandedLabs)}
            >
              {expandedLabs ? "收起检验" : "展开全部检验"}
            </button>
          )}
          {editing?.index === null && editForm(section)}
          {(original.habitChanges || [])
            .filter(
              (c) =>
                c.section === section &&
                c.after === null &&
                !(payload[section] || []).some(
                  (item) => JSON.stringify(item) === JSON.stringify(c.before),
                ),
            )
            .map((c) => (
              <button
                className="review-habit"
                title="点此重新列出"
                aria-label={`按习惯「${c.content}」未列出「${c.before.name}」，点此重新列出`}
                key={`${c.habitId}:${c.index}`}
                onClick={() =>
                  change({
                    ...payload,
                    [section]: [...(payload[section] || []), c.before],
                  })
                }
              >
                按习惯未列出「{c.before.name}」（{c.content}）↺
              </button>
            ))}
        </section>
      ))}
      {payload.note && (
        <details>
          <summary>资料备注与待核对信息</summary>
          <p>{payload.note}</p>
        </details>
      )}
    </div>
  );
}
