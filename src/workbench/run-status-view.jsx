import { Clock, FileCheck2, TriangleAlert, PackageCheck } from "lucide-react";
import {
  WAITING_STATES,
  blockedText,
  evidenceLine,
  gapLine,
  runDerivedStatus,
  waitingNotice,
} from "./run-status";

// 等待/受阻提示（W7）：明确告诉用户「在等什么、能做什么」。
// - 运行中：消费 derivedStatus/waitingReason（服务端未下发时按待审批数归一）；
// - 运行已结束但仍有待审批提案：持续提示，直到用户处理（16.1：是否等待自己）。
export function RunStatusNotice({ run, pendingCount = 0, onApprove }) {
  const active = run && ["running", "queued"].includes(run?.status);
  const status = active
    ? runDerivedStatus(run, pendingCount)
    : pendingCount > 0
      ? "waiting_approval"
      : "";
  if (!WAITING_STATES.includes(status)) return null;
  const info = waitingNotice({
    status,
    reason: run?.waitingReason,
    pendingCount,
  });
  if (!info) return null;
  return (
    <div className={`wb-run-notice ${status}`} role="status">
      {status === "blocked" ? (
        <TriangleAlert size={15} />
      ) : status === "queued" ? (
        <Clock size={15} />
      ) : (
        <FileCheck2 size={15} />
      )}
      <div>
        <b>{info.title}</b>
        <p>{info.detail}</p>
        {status === "blocked" && run?.waitingReason && (
          <small>原因：{blockedText(run.waitingReason)}</small>
        )}
      </div>
      {status === "waiting_approval" && onApprove && (
        <button className="secondary" onClick={onApprove}>
          {info.action}
        </button>
      )}
    </div>
  );
}

// 完成呈现（W7）：区分「已交付」与「已回答但无可验证产物」。
// - delivered：证据摘要（文件/产物名 + SHA-256 前 8 位）；
// - answered：如实说明没有可核对产物与缺口原因，不宣称完成交付。
export function OutcomeCard({ outcome, delivery }) {
  if (!outcome && !delivery) return null;
  const delivered = outcome
    ? outcome === "delivered"
    : delivery?.delivered === true;
  const evidence = delivery?.evidence || [];
  const gaps = delivery?.gaps || [];
  if (delivered)
    return (
      <div className="wb-outcome delivered" aria-label="交付结果">
        <PackageCheck size={15} />
        <div>
          <b>已交付</b>
          <span className="wb-outcome-count">
            {evidence.length > 0 ? `${evidence.length} 项可核对证据` : "交付已核实"}
          </span>
          {evidence.length > 0 && (
            <ul>
              {evidence.slice(0, 5).map((e, i) => (
                <li key={i}>{evidenceLine(e)}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  return (
    <div className="wb-outcome answered" aria-label="交付结果">
      <TriangleAlert size={15} />
      <div>
        <b>已回答，没有可验证产物</b>
        <p>
          助手给出了文字回答，但结束时没有可核对的产物或执行回执；以下为运行时核对的缺口。
          如需文件类成果，请继续明确要生成的文件。
        </p>
        {gaps.length > 0 && (
          <ul>
            {gaps.slice(0, 3).map((g, i) => (
              <li key={i}>{gapLine(g)}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
