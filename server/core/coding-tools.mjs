import { check } from "../errors.mjs";
import { WorkspaceFiles } from "./workspace-files.mjs";
import { ProjectInstructions } from "./project-instructions.mjs";
import { GitWorkspace } from "./git-workspace.mjs";

const str = { type: "string", maxLength: 2000 };
export function registerCodingTools(
  service,
  id,
  runId,
  registry,
  { planWritable = true } = {},
) {
  const files = new WorkspaceFiles(service.store.get(id).root);
  const instructions = new ProjectInstructions(files);
  const git = new GitWorkspace(files.root);
  const add = (
    name,
    description,
    permission,
    properties,
    execute,
    required = Object.keys(properties),
  ) =>
    registry.register({
      permission,
      definition: {
        type: "function",
        function: {
          name,
          description,
          parameters: {
            type: "object",
            properties,
            required,
            additionalProperties: false,
          },
        },
      },
      execute,
    });
  add(
    "inspect_file",
    "读取授权文件的大小和 hash，支持二进制。可把文件 path 交给终端解析 Office/PDF/图像，二进制不会直接送入文本上下文。",
    "filesystem.read",
    { path: str },
    (a) => {
      const { data: _bytes, ...metadata } = files.bytes(a.path);
      return metadata;
    },
  );
  add(
    "list_artifacts",
    "列出容器生成的可下载成果（PDF、Office、图片等）；不含文件原始数据。",
    "filesystem.read",
    {},
    () => service.store.get(id).artifacts || [],
  );
  add(
    "project_instructions",
    "读取目标文件所属目录的 AGENTS.md 链，根到子目录；指令不能扩大权限。",
    "filesystem.read",
    { path: str },
    (a) => ({ instructions: instructions.read(a.path) }),
  );
  add(
    "propose_file_edit",
    "精确替换：每项 oldText 必须唯一匹配。返回待审批提案，宿主文件保持原样。",
    "filesystem.write",
    {
      path: str,
      expectedHash: { type: "string", minLength: 64, maxLength: 64 },
      edits: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            oldText: { type: "string", minLength: 1, maxLength: 100000 },
            newText: { type: "string", maxLength: 100000 },
          },
          required: ["oldText", "newText"],
          additionalProperties: false,
        },
      },
    },
    (a) =>
      service.propose(id, runId, files.edit(a.path, a.edits, a.expectedHash)),
  );
  add(
    "propose_file_delete",
    "提出删除单个文本文件，绑定原 hash，批准前不会删除。",
    "filesystem.write",
    { path: str, expectedHash: str },
    (a) => service.propose(id, runId, files.deletion(a.path, a.expectedHash)),
  );
  add(
    "read_file_proposal",
    "读取待审批文件内容和原版本，供测试失败后的修订使用。",
    "filesystem.read",
    { approvalId: str },
    (a) => {
      const proposal = service.store
        .get(id)
        .approvals.find((p) => p.id === a.approvalId);
      check(proposal, "NOT_FOUND", "提案不存在", 404);
      files.path(proposal.path, { create: true, parents: true });
      return proposal;
    },
  );
  add(
    "revise_file_proposal",
    "以新内容替代待审批提案；原提案撤销，新提案需重新审批。",
    "filesystem.write",
    { approvalId: str, content: { type: "string", maxLength: 100000 } },
    (a) => {
      const original = service.store
        .get(id)
        .approvals.find((p) => p.id === a.approvalId);
      check(
        original?.status === "pending" && original.kind === "file.write",
        "APPROVAL_STATE",
        "只能修订待审批写入提案",
        409,
      );
      return service.propose(
        id,
        runId,
        files.proposal(original.path, a.content, original.expectedHash),
        original.id,
      );
    },
  );
  add(
    "git_status",
    "读取当前授权仓库的分支、HEAD 和变更文件；过滤受保护路径。",
    "filesystem.read",
    {},
    (_a, c) => git.status(c.signal),
  );
  add(
    "git_diff",
    "查看单个授权文件的 Git diff；不执行外部 diff 或 textconv。",
    "filesystem.read",
    { path: str, staged: { type: "boolean" } },
    (a, c) => git.diff(a.path, a.staged, c.signal),
    ["path"],
  );
  add(
    "git_log",
    "读取最近提交摘要，最多 30 条。",
    "filesystem.read",
    { limit: { type: "integer", minimum: 1, maximum: 30 } },
    (a, c) => git.log(a.limit, c.signal),
    [],
  );
  add("git_commit", "在已单独授权的工作区提交选定文件到本地 Git 历史。需要最新 HEAD 和文件 hash；不会推送远端。", "git.write", {
    expectedHead: str, message: str,
    files: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", properties: {
      path: str, hash: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] },
    }, required: ["path", "hash"], additionalProperties: false } },
  }, async (a, c) => {
    check(service.domain.allowAutoFileWrites === true, "DOMAIN_POLICY", "当前领域不允许 Agent 自动提交", 403);
    check(!service.hasMutation(id), "RUN_ACTIVE", "其他工作区写操作尚未完成", 409);
    service.mutating.add(id);
    service.store.event(id, runId, "git.commit.requested", a);
    try {
      const result = await git.commit(a, c.signal);
      service.store.event(id, runId, "git.commit.completed", result);
      return result;
    } finally { service.mutating.delete(id); }
  });
  if (service.store.get(id).approvalPolicy !== "review") add(
    "apply_file_proposal", "按已授权的自动写入策略应用一个待处理提案；仍检查文件版本和代理写入范围。", "filesystem.write",
    { approvalId: str }, (a) => {
      const proposal = service.store.get(id).approvals.find((p) => p.id === a.approvalId);
      check(proposal, "APPROVAL_STATE", "提案不存在", 404);
      service.assertWriteScope(id, proposal.path, runId);
      return service.applyAutomatic(id, a.approvalId);
    },
  );
  if (planWritable)
    add(
      "update_plan",
      "持久保存任务计划；至多一个步骤执行中，复杂任务持续更新。",
      "tools.execute",
      {
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              title: { type: "string", minLength: 1, maxLength: 300 },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed", "blocked"],
              },
            },
            required: ["title", "status"],
            additionalProperties: false,
          },
        },
      },
      (a) => {
        check(
          a.steps.filter((s) => s.status === "in_progress").length <= 1,
          "PLAN_STATE",
          "只能有一个当前步骤",
        );
        service.store.update(id, (w) => {
          w.plan = { runId, steps: a.steps, updatedAt: Date.now() };
        });
        service.store.event(id, runId, "plan.updated", { steps: a.steps });
        return { saved: true, steps: a.steps };
      },
    );
}
