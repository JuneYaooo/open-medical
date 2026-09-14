import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { check } from "../errors.mjs";
import { hashText } from "./workspace-files.mjs";

const MIME = {
  ".mp3":"audio/mpeg", ".wav":"audio/wav", ".m4a":"audio/mp4", ".mp4":"video/mp4", ".webm":"video/webm", ".ogg":"audio/ogg", ".flac":"audio/flac",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
};
export class WorkspaceArtifacts {
  constructor(store) {
    this.store = store;
    const file = store.db
      .prepare("PRAGMA database_list")
      .all()
      .find((d) => d.name === "main")?.file;
    this.directory = join(
      file ? dirname(file) : join(homedir(), ".open-medical-workbench"),
      "agent-artifacts",
    );
  }
  save(owner, name, data, runId) {
    const workspace = this.store.get(owner);
    check(
      Buffer.isBuffer(data) && data.length <= (/\.mp4$/i.test(name) ? 100000000 : 10000000),
      "ARTIFACT_LIMIT",
      "单份成果不能超过 10MB，MP4 视频上限 100MB",
    );
    const artifacts = workspace.artifacts || [];
    check(
      artifacts.length < 100 &&
        artifacts.reduce((total, a) => total + a.size, 0) + data.length <=
          500000000,
      "ARTIFACT_LIMIT",
      "工作区成果超过 100 份或 500MB",
    );
    const item = {
      id: randomUUID(),
      name,
      hash: hashText(data),
      size: data.length,
      mime: MIME[extname(name).toLowerCase()] || "application/octet-stream",
      runId,
      createdAt: Date.now(),
      storage: "local-artifact",
    };
    const directory = join(this.directory, owner);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, item.id);
    writeFileSync(path, data, { flag: "wx", mode: 0o600 });
    try {
      this.store.update(owner, (w) => {
        w.artifacts ||= [];
        w.artifacts.push(item);
      });
    } catch (error) {
      unlinkSync(path);
      throw error;
    }
    this.store.event(owner, runId, "artifact.created", item);
    return item;
  }
  read(owner, id) {
    const item = this.store.get(owner).artifacts?.find((a) => a.id === id);
    check(item, "NOT_FOUND", "成果不存在或不属于此工作区", 404);
    const data = readFileSync(join(this.directory, owner, item.id));
    check(
      hashText(data) === item.hash,
      "ARTIFACT_CHANGED",
      "成果文件已被外部修改",
      409,
    );
    return { item, data };
  }
}
