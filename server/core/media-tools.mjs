import { randomUUID } from "node:crypto";
import { check } from "../errors.mjs";
import { imageMime } from "../../shared/image-input.mjs";
export class MediaTools {
  constructor(service, { fetchImpl = fetch } = {}) {
    this.service = service;
    this.fetch = fetchImpl;
    this.active = new Map();
  }
  async execute(id, args, { signal, runId = "manual" } = {}) {
    check(
      this.active.size < 3 &&
        ![...this.active.values()].some((item) => item.owner === id),
      "MEDIA_BUSY",
      "媒体请求正在处理中，请等待结束",
      429,
    );
    const w = this.service.store.get(id);
    check(
      ["image", "transcribe", "speech"].includes(args.action),
      "MEDIA_ACTION",
      "未知媒体操作",
    );
    check(
      (w.teamModels || []).includes(args.modelProfile),
      "MEDIA_CONSENT",
      "请先在团队模型设置中授权媒体模型连接",
      403,
    );
    const config = this.service.modelProfiles?.all()[args.modelProfile];
    check(
      config &&
        ["openai", "openai-compatible", "openai-responses", "local"].includes(
          config.provider,
        ),
      "MEDIA_PROVIDER",
      "媒体操作需要兼容 OpenAI 媒体接口的连接",
    );
    const headers = {
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    };
    let suffix, body;
    if (args.action === "transcribe") {
      const { item, data } = this.service.artifacts.read(id, args.artifactId);
      check(
        /\.(mp3|mp4|m4a|wav|webm|ogg|flac)$/i.test(item.name),
        "MEDIA_INPUT",
        "请选择已上传的音频或视频",
      );
      const form = new FormData();
      form.set("model", config.model);
      form.set("file", new Blob([data], { type: item.mime }), item.name);
      body = form;
      suffix = "audio/transcriptions";
    } else {
      check(
        typeof args.text === "string" &&
          args.text.trim() &&
          args.text.length <= (args.action === "speech" ? 4096 : 10000),
        "MEDIA_TEXT",
        "请填写有效文本；语音最多 4096 字符，图像最多 10000 字符",
      );
      headers["Content-Type"] = "application/json";
      if (args.action === "image") {
        body = JSON.stringify({ model: config.model, prompt: args.text, n: 1 });
        suffix = "images/generations";
      } else {
        check(
          typeof args.voice === "string" && /^[a-z]{2,20}$/.test(args.voice),
          "MEDIA_VOICE",
          "请选择服务商提供的预设音色",
        );
        body = JSON.stringify({
          model: config.model,
          input: args.text,
          voice: args.voice,
          response_format: "mp3",
        });
        suffix = "audio/speech";
      }
    }
    const controller = new AbortController(),
      key = randomUUID();
    this.active.set(key, { owner: id, controller });
    try {
      const signals = [
        controller.signal,
        AbortSignal.timeout(120000),
        ...(signal ? [signal] : []),
      ];
      this.service.store.event(id, runId, "media.requested", {
        action: args.action,
        profile: args.modelProfile,
      });
      const response = await this.fetch(
        `${config.baseUrl.replace(/\/$/, "")}/${suffix}`,
        {
          method: "POST",
          headers,
          body,
          redirect: "error",
          signal: AbortSignal.any(signals),
        },
      );
      check(
        response.ok && response.body,
        "MEDIA_PROVIDER",
        `媒体服务请求失败（HTTP ${response.status}），请检查模型、额度及该接口是否受支持`,
      );
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        check(size <= 15_000_000, "MEDIA_LIMIT", "服务返回内容超过 15MB");
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      let output, name, text, usage;
      if (args.action === "speech") {
        output = buffer;
        name = "AI语音-" + Date.now() + ".mp3";
      } else {
        let data;
        try {
          data = JSON.parse(buffer.toString());
        } catch {
          check(false, "MEDIA_RESPONSE", "媒体服务未返回有效 JSON");
        }
        usage = data.usage;
        if (args.action === "transcribe") {
          check(
            typeof data.text === "string",
            "MEDIA_RESPONSE",
            "服务未返回转写文本",
          );
          text = data.text;
          output = Buffer.from(text);
          name = "转写-" + Date.now() + ".txt";
        } else {
          check(
            typeof data.data?.[0]?.b64_json === "string",
            "MEDIA_RESPONSE",
            "当前接口需返回 b64_json 图片数据",
          );
          output = Buffer.from(data.data[0].b64_json, "base64");
          const mime = imageMime(output);
          check(mime, "MEDIA_RESPONSE", "返回的图片格式无效");
          name =
            "生成图片-" +
            Date.now() +
            "." +
            { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[
              mime
            ];
        }
      }
      // Authorization may have been revoked while an external request was running.
      check(
        (this.service.store.get(id).teamModels || []).includes(
          args.modelProfile,
        ),
        "MEDIA_CONSENT",
        "媒体模型授权已撤销",
        403,
      );
      controller.signal.throwIfAborted();
      signal?.throwIfAborted();
      const artifact = this.service.artifacts.save(id, name, output, runId);
      this.service.store.event(id, runId, "media.completed", {
        action: args.action,
        artifactId: artifact.id,
        usage,
      });
      return { artifact, ...(text ? { text } : {}), usage };
    } finally {
      this.active.delete(key);
    }
  }
  stop(owner) {
    for (const item of this.active.values())
      if (!owner || item.owner === owner) item.controller.abort();
    return { cancelled: true };
  }
}
