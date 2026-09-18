import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PermissionEngine } from "./permissions.mjs";
import { check } from "../errors.mjs";

const BRIDGE = `import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
const pending = new Map(); let seq = 0;
const input = createInterface({input:process.stdin});
input.on('line', line => { const r=JSON.parse(line); const p=pending.get(r.id); if(!p)return; pending.delete(r.id); r.error?p.reject(new Error(r.error)):p.resolve(r.value); });
const tools = new Proxy(Object.create(null), { get(_target,name) { if(name==='then')return undefined; return args => new Promise((resolve,reject)=>{ const id=++seq; pending.set(id,{resolve,reject}); process.stdout.write(JSON.stringify({type:'call',id,name,args:args||{}})+'\\n'); }); } });
try {
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const result=await new AsyncFunction('tools',readFileSync('/program/code.js','utf8'))(tools);
 if(pending.size)throw new Error('All tool calls must be awaited');
 process.stdout.write(JSON.stringify({type:'result',value:result??null})+'\\n');
 input.close(); process.stdin.destroy();
} catch(e) { process.stderr.write(String(e.message)); process.exitCode=1; input.close();process.stdin.destroy(); }
`;

export async function executeCode(service, id, registry, code, context) {
  const w = service.store.get(id),
    permission = new PermissionEngine(w.permissions);
  permission.require("process.spawn");
  check(
    w.extensions?.image,
    "SANDBOX_IMAGE",
    "Code SDK 需要已配置的 Node 容器镜像",
  );
  const staging = join(homedir(), ".open-medical-workbench", "sandbox-staging");
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(staging, "agent-code-"));
  await chmod(directory, 0o755);
  await writeFile(join(directory, "bridge.mjs"), BRIDGE, { mode: 0o644 });
  await writeFile(join(directory, "code.js"), code, { mode: 0o644 });
  const runner = service.extensions.runner,
    calls = new Set(),
    ids = new Set(),
    controller = new AbortController();
  const signal = AbortSignal.any([
    ...(context.signal ? [context.signal] : []),
    controller.signal,
  ]);
  let buffer = "",
    result,
    complete = false,
    session;
  const handle = async (request) => {
    let reply;
    try {
      check(
        typeof request.name === "string" && request.name !== "code_execute",
        "CODE_RECURSION",
        "Code SDK 不允许递归执行自身",
      );
      registry.authorize(request.name, permission);
      const args = { name: request.name, args: request.args, signal, context };
      await service.domain.beforeTool?.(args);
      await service.extensions.runHooks(
        id,
        "tool_start",
        { tool: request.name, arguments: request.args },
        signal,
        context.runId,
      );
      signal.throwIfAborted();
      const value = await registry.execute(
        request.name,
        request.args,
        { ...context, signal },
        permission,
      );
      await service.extensions.runHooks(
        id,
        "tool_end",
        { tool: request.name },
        signal,
        context.runId,
      );
      check(
        JSON.stringify(value ?? null).length < 256000,
        "CODE_OUTPUT",
        "SDK 单工具结果超过 256KB，请分段读取",
      );
      reply = { id: request.id, value };
    } catch (error) {
      reply = {
        id: request.id,
        error: error.code ? error.message : "工具执行失败",
      };
    }
    service.store.trace(id, context.runId, {
      type: "code.tool",
      request,
      reply,
    });
    if (!signal.aborted && session && !session.child.stdin.destroyed)
      session.child.stdin.write(JSON.stringify(reply) + "\n");
  };
  try {
    const start = runner.start(
      id,
      {
        image: w.extensions.image,
        runId: context.runId,
        mounts: [{ source: directory, target: "/program", readonly: true }],
        command: ["node", "/program/bridge.mjs"],
        timeoutMs: 120000,
        // 桥通过 stdin 接收工具回复，必须保持管道打开。
        interactive: true,
      },
      {
        signal,
        stdoutTransform(chunk) {
          buffer += chunk.toString();
          check(buffer.length < 512000, "CODE_PROTOCOL", "SDK 输出帧过大");
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const frame = JSON.parse(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            check(!complete, "CODE_PROTOCOL", "SDK 完成后不能再调用工具");
            if (frame.type === "result") {
              result = frame.value;
              complete = true;
            } else {
              check(
                frame.type === "call" &&
                  Number.isSafeInteger(frame.id) &&
                  !ids.has(frame.id) &&
                  ids.size < 32 &&
                  calls.size < 8,
                "CODE_BUDGET",
                "SDK 调用无效，或超过 32 次 / 8 并发预算",
              );
              ids.add(frame.id);
              const promise = handle(frame);
              calls.add(promise);
              promise.finally(() => calls.delete(promise)).catch(() => {});
            }
          }
          return "";
        },
      },
    );
    session = runner.get(id, start.id);
    session.child.stdin.on("error", () => {});
    const ended = await session.done;
    controller.abort();
    await Promise.allSettled([...calls]);
    check(
      complete && ended.status === "completed" && ended.exitCode === 0,
      "CODE_FAILED",
      "SDK 程序未完成：" + (ended.error || ended.output || ended.status),
      422,
    );
    return {
      value: result,
      toolCalls: ids.size,
      environment: "isolated-node",
      exitCode: 0,
    };
  } finally {
    controller.abort();
    await Promise.allSettled([...calls]);
    if (session?.status === "running") runner.stop(id, session.id);
    await rm(directory, { recursive: true, force: true });
  }
}
