import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { PermissionEngine } from "./permissions.mjs";
import { check } from "../errors.mjs";
import { checkToolAvailability } from "./tool-registry.mjs";

const BRIDGE = `import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
const frameMarker = __FRAME_MARKER__;
const protocolWrite = process.stdout.write.bind(process.stdout);
const emit = (frame) => protocolWrite(frameMarker + JSON.stringify(frame) + '\\n');
const pending = new Map(); let seq = 0;
const input = createInterface({input:process.stdin});
input.on('line', line => { const r=JSON.parse(line); const p=pending.get(r.id); if(!p)return; pending.delete(r.id); r.error?p.reject(new Error(r.error)):p.resolve(r.value); });
const tools = new Proxy(Object.create(null), { get(_target,name) { if(name==='then')return undefined; return args => new Promise((resolve,reject)=>{ const id=++seq; pending.set(id,{resolve,reject}); emit({type:'call',id,name,args:args||{}}); }); } });
try {
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const result=await new AsyncFunction('tools',readFileSync('/program/code.js','utf8'))(tools);
 if(pending.size)throw new Error('All tool calls must be awaited');
 emit({type:'result',value:result??null});
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
  const marker = `\u001eOMWSDK:${randomBytes(16).toString("hex")}:`;
  await writeFile(
    join(directory, "bridge.mjs"),
    BRIDGE.replace("__FRAME_MARKER__", JSON.stringify(marker)),
    { mode: 0o644 },
  );
  await writeFile(join(directory, "code.js"), code, { mode: 0o644 });
  const runner = service.extensions.runner,
    calls = new Set(),
    ids = new Set(),
    controller = new AbortController();
  const signal = AbortSignal.any([
    ...(context.signal ? [context.signal] : []),
    controller.signal,
  ]);
  const decoder = new StringDecoder("utf8");
  let stdout = "",
    forwarded = "",
    stdoutTruncated = false;
  const capture = (text) => {
    forwarded += text;
    stdout += text;
    if (stdout.length > 128000) {
      stdout = stdout.slice(-128000);
      stdoutTruncated = true;
    }
  };
  let buffer = "",
    result,
    complete = false,
    session;
  const endInput = () => {
    // A validated final frame is one-way: no further calls/replies are legal.
    // Half-close the Docker client's input, but still require its actual exit.
    if (
      complete &&
      session &&
      !session.child.stdin.destroyed &&
      !session.child.stdin.writableEnded
    )
      session.child.stdin.end();
  };
  const handle = async (request) => {
    let reply;
    try {
      check(
        typeof request.name === "string" && request.name !== "code_execute",
        "CODE_RECURSION",
        "Code SDK 不允许递归执行自身",
      );
      registry.authorize(request.name, permission);
      checkToolAvailability(request.name, context);
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
          forwarded = "";
          buffer += decoder.write(chunk);
          // User stdout is ordinary data, including console output, direct
          // process.stdout.write and fs.writeSync(1). Only this invocation's
          // tagged frames are protocol messages. Preserve a split marker tail.
          for (;;) {
            const start = buffer.indexOf(marker);
            if (start < 0) {
              const end = Math.max(0, buffer.length - marker.length + 1);
              capture(buffer.slice(0, end));
              buffer = buffer.slice(end);
              break;
            }
            capture(buffer.slice(0, start));
            buffer = buffer.slice(start);
            const newline = buffer.indexOf("\n", marker.length);
            check(
              (newline < 0 ? buffer.length : newline) < 512000,
              "CODE_PROTOCOL",
              "SDK 输出帧过大",
            );
            if (newline < 0) break;
            const frame = JSON.parse(buffer.slice(marker.length, newline));
            buffer = buffer.slice(newline + 1);
            check(!complete, "CODE_PROTOCOL", "SDK 完成后不能再调用工具");
            if (frame.type === "result") {
              result = frame.value;
              complete = true;
              endInput();
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
          return forwarded;
        },
      },
    );
    session = runner.get(id, start.id);
    session.child.stdin.on("error", () => {});
    endInput();
    const ended = await session.done;
    const tail = buffer + decoder.end();
    capture(tail);
    buffer = "";
    // The transform retains only a possible split marker tail. At EOF it is
    // ordinary output and must also remain visible in failure receipts.
    if (tail) {
      session.output += tail;
      if (session.output.length > 128000) {
        session.offset += session.output.length - 128000;
        session.output = session.output.slice(-128000);
      }
      ended.output = runner.read(id, session.id).output;
    }
    controller.abort();
    await Promise.allSettled([...calls]);
    check(
      complete && ended.status === "completed" && ended.exitCode === 0,
      "CODE_FAILED",
      "SDK 程序未完成：" +
        (ended.error || ended.output || stdout || ended.status),
      422,
    );
    return {
      value: result,
      toolCalls: ids.size,
      environment: "isolated-node",
      stdout,
      stdoutTruncated,
      exitCode: 0,
    };
  } finally {
    controller.abort();
    await Promise.allSettled([...calls]);
    if (session?.status === "running") runner.stop(id, session.id);
    await rm(directory, { recursive: true, force: true });
  }
}
