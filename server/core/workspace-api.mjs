import { check } from "../errors.mjs";
import { publicWorkspace } from "./workspace-service.mjs";
import { replayTrajectory } from "./trajectory-replay.mjs";
export async function workspaceApi({
  service,
  path,
  req,
  res,
  url,
  body,
  send,
  track,
}) {
  if (path !== "/api/workspaces" && !path.startsWith("/api/workspaces/"))
    return false;
  const parts = path.split("/").filter(Boolean);
  const id = parts[2],
    action = parts[3];
  if(id && action === "realtime" && req.method === "DELETE"){const input=await body(req);send(res,200,await service.advancedMedia.endCall(id,input.sessionId));return true;}
  if(id && action === "realtime-tool" && req.method === "POST"){send(res,200,await service.advancedMedia.realtimeTool(id,await body(req)));return true;}
  if (id && action === "remote-jobs" && req.method === "POST") { send(res, 200, await track(service.remoteJobs.execute(id, await body(req)))); return true; }
  if (id && action === "desktop" && req.method === "POST") { send(res, 200, await track(service.desktop.execute(id, await body(req)))); return true; }
  if (id && action === "videos" && req.method === "GET") {
    send(res, 200, { jobs: service.advancedMedia.list(id) }); return true;
  }
  if (id && ["videos", "realtime"].includes(action) && req.method === "POST") {
    const input = await body(req);
    send(res, 200, await track(action === "videos" ? service.advancedMedia.video(id, input) : service.advancedMedia.realtime(id, input))); return true;
  }
  if (id && action === "file" && req.method === "GET") {
    // Read-only binary preview for images/PDF; all path protections of
    // WorkspaceFiles apply and only safe inline types are ever served.
    const path = url.searchParams.get("path") || "";
    const { data, mime } = service.previewFile(id, path);
    res.writeHead(200, {
      "content-type": mime,
      "content-disposition": "inline",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'",
    });
    res.end(data);
    return true;
  }
  if (id && action === "artifacts" && parts[4] && req.method === "GET") {
    const { item, data } = service.artifacts.read(id, parts[4]);
    res.writeHead(200, {
      "content-type": item.mime,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(item.name.split(/[\\/]/).at(-1))}`,
      "cache-control": "no-store",
    });
    res.end(data);
    return true;
  }
  if (id && action === "upload-media" && req.method === "POST") {
    const name = url.searchParams.get("name") || "";
    check(
      name.length <= 150 &&
        !/[\\/\0]/.test(name) &&
        /\.(mp3|mp4|m4a|wav|webm|ogg|flac)$/i.test(name),
      "MEDIA_INPUT",
      "仅支持音视频文件名",
    );
    check(
      service.get(id).permissions.grants["filesystem.read"],
      "PERMISSION_DENIED",
      "目录授权已撤销",
      403,
    );
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      check(size <= 10_000_000, "MEDIA_LIMIT", "音视频最多 10MB", 413);
      chunks.push(chunk);
    }
    check(size > 0, "MEDIA_INPUT", "文件不能为空");
    send(
      res,
      201,
      service.artifacts.save(id, name, Buffer.concat(chunks), "input-media"),
    );
    return true;
  }
  if (id && action === "media") {
    if (req.method === "DELETE") {
      send(res, 200, service.media.stop(id));
      return true;
    }
    if (req.method === "POST") {
      const input = await body(req);
      check(
        input.consent === true,
        "MEDIA_CONSENT",
        "请授权将所选文本或音视频发送给媒体模型",
        412,
      );
      check(!service.active.has(id), "RUN_ACTIVE", "请等待 Agent 结束", 409);
      send(res, 200, await track(service.media.execute(id, input)));
      return true;
    }
  }
  if (id && action === "pty") {
    if (req.method === "GET") {
      send(
        res,
        200,
        parts[4]
          ? service.pty.read(
              id,
              parts[4],
              Number(url.searchParams.get("cursor") || 0),
            )
          : {
              sessions: [...service.pty.sessions.values()]
                .filter((s) => s.owner === id)
                .map((s) => service.pty.read(id, s.id)),
            },
      );
      return true;
    }
    if (req.method === "POST") {
      const input = await body(req);
      let result;
      if (!parts[4]) result = await track(service.pty.start(id, input));
      else if (input.action === "write")
        result = service.pty.write(id, parts[4], input.data);
      else if (input.action === "resize")
        result = service.pty.resize(id, parts[4], input.cols, input.rows);
      else if (input.action === "stop") result = service.pty.stop(id, parts[4]);
      else check(false, "PTY_ACTION", "未知终端操作");
      send(res, 200, result);
      return true;
    }
  }
  if (id && action === "git-conflicts" && req.method === "POST") {
    send(res, 200, await track(service.gitConflicts(id, await body(req))));
    return true;
  }
  if (id && action === "remote-git" && req.method === "POST") {
    send(res, 200, await track(service.remoteGit(id, await body(req))));
    return true;
  }
  if (id && action === "team-models" && req.method === "PUT") {
    send(res, 200, service.configureTeam(id, await body(req)));
    return true;
  }
  if (id && action === "images" && req.method === "POST") {
    send(res, 201, service.uploadImage(id, await body(req)));
    return true;
  }
  if (id && action === "organization" && req.method === "PATCH") {
    send(res, 200, service.organize(id, await body(req)));
    return true;
  }
  if (id && action === "tasks" && req.method === "POST") {
    send(res, 201, service.newTask(id));
    return true;
  }
  if (id && action === "capabilities" && req.method === "GET") {
    send(res, 200, service.capabilities(id));
    return true;
  }
  // 能力分层快照（B1）：与模型可调用列表共用 WorkspaceService 判定；
  // 展示全部工具及 authorized/ready/executable 三态与稳定原因码。
  if (id && action === "capability-snapshot" && req.method === "GET") {
    send(res, 200, service.capabilitySnapshot(id));
    return true;
  }
  if (id && action === "history" && req.method === "GET") {
    send(
      res,
      200,
      service.store.history(id, {
        before: Number(
          url.searchParams.get("before") || Number.MAX_SAFE_INTEGER,
        ),
        query: url.searchParams.get("q") || "",
      }),
    );
    return true;
  }
  if (action === "notifications" && parts[4] && req.method === "POST") {
    send(res, 200, service.acknowledge(id, parts[4]));
    return true;
  }
  if (id && action === "worktree" && req.method === "POST") {
    send(res, 201, await track(service.createWorktree(id, await body(req))));
    return true;
  }
  if (id && action === "commit" && req.method === "POST") {
    send(res, 200, await track(service.commit(id, await body(req))));
    return true;
  }
  if (id === "pick-directory" && req.method === "POST") {
    check(
      typeof service.chooseDirectory === "function",
      "PICKER_UNAVAILABLE",
      "文件夹选择器仅在桌面版可用，请填写路径",
      503,
    );
    send(res, 200, { root: await service.chooseDirectory() });
    return true;
  }
  if (!id) {
    if (req.method === "GET") {
      send(res, 200, {
        workspaces: service
          .list()
          .filter((w) => w.kind !== "session"),
      });
      return true;
    }
    if (req.method === "POST") {
      send(res, 201, service.create(await body(req)));
      return true;
    }
  }
  if (id && !action && req.method === "GET") {
    send(res, 200, service.get(id));
    return true;
  }
  if (id && !action && req.method === "PATCH") {
    send(res, 200, service.update(id, await body(req)));
    return true;
  }
  if (action === "extensions") {
    if (req.method === "GET") {
      send(res, 200, service.extensions.status(id));
      return true;
    }
    if (req.method === "POST") {
      send(
        res,
        200,
        await track(service.extensions.operation(id, await body(req))),
      );
      return true;
    }
  }
  if (action === "schedules" && req.method === "POST") {
    if (parts[4]) {
      send(
        res,
        200,
        publicWorkspace(
          service.scheduler.change(id, parts[4], await body(req)),
        ),
      );
      return true;
    }
    send(res, 201, service.scheduler.create(id, await body(req)));
    return true;
  }
  if (action === "events" && req.method === "GET") {
    const events =
      url.searchParams.get("latest") === "1"
        ? service.store.eventsLatest(id)
        : service.store.events(
            id,
            Number(url.searchParams.get("after") || 0),
          );
    send(res, 200, {
      events,
      cursor: events.at(-1)?.id ?? Number(url.searchParams.get("after") || 0),
    });
    return true;
  }
  if (action === "fork" && req.method === "POST") {
    send(res, 201, publicWorkspace(service.store.fork(id, await body(req))));
    return true;
  }
  if (action === "tools" && req.method === "POST") {
    send(res, 200, await track(service.tool(id, await body(req))));
    return true;
  }
  if (
    action === "approvals" &&
    parts[4] &&
    parts[5] === "revert" &&
    req.method === "POST"
  ) {
    send(res, 200, service.revert(id, parts[4], await body(req)));
    return true;
  }
  if (action === "approvals" && parts[4] && req.method === "POST") {
    send(res, 200, service.decide(id, parts[4], await body(req)));
    return true;
  }
  if (action === "cancel" && req.method === "POST") {
    send(res, 200, { cancelled: service.cancel(id) });
    return true;
  }
  if (action === "steer" && req.method === "POST") {
    send(res, 202, service.steer(id, await body(req)));
    return true;
  }
  if (action === "trajectory" && parts[4] && req.method === "GET") {
    const entries = service.store.trajectory(
      id,
      parts[4],
      Number(url.searchParams.get("after") || 0),
    );
    send(res, 200, { entries, cursor: entries.at(-1)?.id || 0 });
    return true;
  }
  if (action === "replay" && parts[4] && req.method === "GET") {
    send(res, 200, replayTrajectory(service.store, id, parts[4]));
    return true;
  }
  if (action === "runs" && req.method === "POST") {
    const handle = service.prepare(id, await body(req));
    // Execution belongs to the application process, not to this short HTTP connection.
    void track(service.execute(handle)).catch(() => {});
    send(res, 202, {
      runId: handle.run.id,
      status: "running",
      background: true,
    });
    return true;
  }
  if (action === "run" && req.method === "POST") {
    const handle = service.prepare(id, await body(req));
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    const close = () => {
      if (!res.writableEnded) service.cancel(id);
    };
    res.on("close", close);
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(": heartbeat\n\n");
    }, 10000);
    try {
      await track(
        service.execute(handle, (event) => {
          if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
        }),
      );
    } finally {
      clearInterval(heartbeat);
      res.removeListener("close", close);
      res.end();
    }
    return true;
  }
  check(false, "NOT_FOUND", "工作区接口不存在", 404);
}
