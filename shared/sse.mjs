// SSE decoder shared by provider and browser. Handles UTF-8 byte fragmentation,
// CRLF, comments, multi-line data and un-terminated final frames.
export async function* sseFrames(stream, { maxBuffer = 1024 * 1024 } = {}) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data = [];
  let event = "message";
  function line(value) {
    if (value === "") {
      const frame = data.length ? { event, data: data.join("\n") } : null;
      data = [];
      event = "message";
      return frame;
    }
    if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
    if (value.startsWith("event:")) event = value.slice(6).trim();
    return null;
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length + data.join("").length > maxBuffer)
        throw new Error("流式数据帧过大");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const part = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        const frame = line(part);
        if (frame) yield frame;
      }
      if (done) break;
    }
    if (buffer) {
      const frame = line(buffer.replace(/\r$/, ""));
      if (frame) yield frame;
    }
    const tail = line("");
    if (tail) yield tail;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
