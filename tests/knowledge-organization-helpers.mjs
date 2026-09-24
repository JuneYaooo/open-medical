export const organizerProvider = {
  provider: "stub",
  model: "stub",
  apiKey: "stub",
  async complete(messages) {
    if (messages.some((m) => m.role === "tool"))
      return { message: { role: "assistant", content: "本批已保存。" } };
    const content = messages.findLast((m) => m.role === "user").content;
    const match =
      content.match(/L(\d+): (.*讨论.*)/) ||
      content.match(/L(\d+): ([^\n]{4,})/);
    const quote = match[2].slice(0, 200),
      line = Number(match[1]);
    const value = {
      title: "合成资料主题",
      summary: "本批资料讨论合成疾病和检查。",
      nodes: [
        {
          label: "合成疾病",
          type: "疾病",
          quote,
          startLine: line,
          endLine: line,
        },
        {
          label: "合成检查",
          type: "检查",
          quote,
          startLine: line,
          endLine: line,
        },
      ],
      relations: [
        {
          from: "合成疾病",
          to: "合成检查",
          relation: "资料讨论",
          quote,
          startLine: line,
          endLine: line,
        },
      ],
    };
    return {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "knowledge-batch",
            type: "function",
            function: {
              name: "save_knowledge_batch",
              arguments: JSON.stringify(value),
            },
          },
        ],
      },
    };
  },
};
export async function library(f, name = "合成知识库") {
  await f.json(
    "/api/knowledge/collections/" + encodeURIComponent(name),
    "PUT",
    { expectedRevision: 0, description: "合成测试", whenToUse: "软件测试" },
  );
  return name;
}
export async function upload(f, collection, name, text, consent = true) {
  const res = await fetch(
    f.origin +
      "/api/knowledge/organization?" +
      new URLSearchParams({ collection, name }),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-medical-token": f.server.token,
        "x-knowledge-consent": String(consent),
      },
      body: text,
    },
  );
  return { status: res.status, data: await res.json() };
}
export async function waitJob(f, id) {
  for (let i = 0; i < 500; i++) {
    const job = f.server.knowledgeOrganizer.get(id);
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Job did not settle");
}
