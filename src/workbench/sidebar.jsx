import { useState } from "react";
import {
  Plus,
  Search,
  Settings2,
  FolderOpen,
  MessageSquare,
  Pin,
  Archive,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  SlidersHorizontal,
  X,
} from "lucide-react";
export function TaskSidebar({
  items,
  current,
  onSelect,
  onCreate,
  onNewTask,
  onSettings,
  onWorkspaceSettings,
  model,
  onOrganize,
  disabled,
}) {
  const [query, setQuery] = useState(""),
    [archive, setArchive] = useState(false),
    [menu, setMenu] = useState(null),
    [editing, setEditing] = useState(null),
    [name, setName] = useState("");
  const visible = items.filter(
    (w) =>
      Boolean(w.archived) === archive &&
      `${w.title} ${w.root}`.toLowerCase().includes(query.toLowerCase()),
  );
  const pinned = visible.filter((w) => w.pinned);
  const roots = [...new Set(visible.map((w) => w.root))];
  function row(w) {
    return (
      <div
        className={`wb-task ${w.id === current?.id ? "selected" : ""}`}
        key={w.id}
      >
        {editing === w.id ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (await onOrganize(w, { title: name })) setEditing(null);
            }}
          >
            <input
              autoFocus
              aria-label="任务名称"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(null);
              }}
            />
            <button disabled={!name.trim()}>保存</button>
            <button
              type="button"
              onClick={() => setEditing(null)}
              aria-label="取消重命名"
            >
              <X size={12} />
            </button>
          </form>
        ) : (
          <>
            <button
              className="wb-task-select"
              disabled={disabled}
              onClick={() => onSelect(w.id)}
              title={w.title}
            >
              <span
                className={`wb-dot ${w.running ? "running" : w.pending ? "pending" : w.status === "failed" ? "failed" : ""}`}
              />
              <span>{w.title}</span>
              {w.pending > 0 && <small>{w.pending}</small>}
            </button>
            <button
              className="wb-task-menu"
              aria-label={`管理 ${w.title}`}
              onClick={() => setMenu(menu === w.id ? null : w.id)}
            >
              <MoreHorizontal size={15} />
            </button>
            {menu === w.id && (
              <div className="wb-popover">
                <button
                  onClick={() => {
                    setName(w.title);
                    setEditing(w.id);
                    setMenu(null);
                  }}
                >
                  <Pencil size={13} />
                  重命名
                </button>
                <button
                  onClick={() => {
                    onOrganize(w, { pinned: !w.pinned });
                    setMenu(null);
                  }}
                >
                  <Pin size={13} />
                  {w.pinned ? "取消置顶" : "置顶"}
                </button>
                <button
                  disabled={w.running}
                  onClick={() => {
                    onOrganize(w, { archived: !w.archived });
                    setMenu(null);
                  }}
                >
                  <RotateCcw size={13} />
                  {w.archived ? "恢复任务" : "归档任务"}
                </button>
                <button onClick={() => setMenu(null)}>关闭菜单</button>
              </div>
            )}
          </>
        )}
      </div>
    );
  }
  return (
    <>
      <div className="desk-brand">
        <MessageSquare size={20} />
        <strong>Open Agent</strong>
      </div>
      <button className="desk-new" onClick={onCreate} disabled={disabled}>
        <Plus size={16} />
        连接项目
      </button>
      <label className="desk-search">
        <Search size={14} />
        <input
          aria-label="搜索任务或项目"
          placeholder="搜索任务或项目"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="wb-sidebar-scroll">
        {pinned.length > 0 && (
          <section>
            <h2>
              <Pin size={12} />
              置顶
            </h2>
            {pinned.map(row)}
          </section>
        )}
        {roots.map((root) => (
          <section className="wb-project" key={root}>
            <header>
              <FolderOpen size={14} />
              <span title={root}>
                {root.split(/[\\/]/).filter(Boolean).at(-1) || root}
              </span>
              {!archive && (
                <button
                  disabled={disabled}
                  title="在此项目中新建任务"
                  aria-label={`在 ${root} 新建任务`}
                  onClick={() =>
                    onNewTask(visible.find((w) => w.root === root))
                  }
                >
                  <Plus size={14} />
                </button>
              )}
            </header>
            {visible.filter((w) => !w.pinned && w.root === root).map(row)}
          </section>
        ))}
        {!visible.length && (
          <p className="wb-muted">
            {query
              ? "没有匹配的任务"
              : archive
                ? "没有归档任务"
                : "连接一个文件夹，开始工作。"}
          </p>
        )}
      </div>
      <footer className="wb-sidebar-footer">
        <button aria-pressed={archive} onClick={() => setArchive(!archive)}>
          <Archive size={16} />
          {archive ? "返回任务" : "已归档"}
        </button>
        <button
          className="wb-model-entry"
          onClick={onSettings}
          title="本机模型连接设置"
        >
          <Settings2 size={16} />
          <span className="wb-model-name">{model || "连接模型"}</span>
        </button>
        <button
          disabled={!current}
          onClick={onWorkspaceSettings}
          title={current ? "当前工作区的计划任务与扩展能力" : "先选择一个工作区"}
        >
          <SlidersHorizontal size={16} />
          工作区
        </button>
      </footer>
    </>
  );
}
