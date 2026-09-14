import { useEffect, useRef } from "react";
import { X } from "lucide-react";

export const STATUS = {
  completed: "已完成",
  running: "执行中",
  failed: "失败",
  cancelled: "已停止",
  interrupted: "已中断",
  draft: "待复核",
  approved: "已复核",
  rejected: "需修订",
};
export function IconButton({ title, children, ...props }) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={title}
      title={title}
      {...props}
    >
      {children}
    </button>
  );
}
export function Badge({ status }) {
  return <span className={`badge ${status}`}>{STATUS[status] || status}</span>;
}
export function Modal({ title, onClose, children, wide = false }) {
  const ref = useRef();
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.focus();
    const key = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const nodes = ref.current.querySelectorAll(
          "button,input,textarea,select,a[href]",
        );
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <section
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <IconButton title="关闭" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        {children}
      </section>
    </div>
  );
}
