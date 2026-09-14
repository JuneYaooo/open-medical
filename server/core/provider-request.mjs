import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "../errors.mjs";

// Retry only before a response stream is handed to the caller. Never replay a
// partially consumed model stream or a tool side effect.
export async function requestProvider(fetchImpl, url, init, onStatus = () => {}, sleep = delay) {
  for (let attempt = 0; attempt < 3; attempt++) {
    init.signal?.throwIfAborted();
    let response;
    try { response = await fetchImpl(url, init); }
    catch (error) {
      init.signal?.throwIfAborted();
      if (!(error instanceof TypeError) && !["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"].includes(error.code)) throw error;
      if (attempt === 2 || error.name === "AbortError")
        throw new AppError("PROVIDER_NETWORK", "模型连接失败，有限重试后仍不可用；检查点已保留", 502);
      onStatus({ status: "retrying", attempt: attempt + 1, reason: "network" });
      await sleep(300 * 2 ** attempt, undefined, { signal: init.signal });
      continue;
    }
    if (![429, 500, 502, 503, 504, 529].includes(response.status) || attempt === 2) return response;
    const header = response.headers.get("retry-after");
    const requested = header === null ? NaN : /^\d+(\.\d+)?$/.test(header)
      ? Number(header) * 1000 : Date.parse(header) - Date.now();
    const waitMs = Math.min(5000, Math.max(250, Number.isFinite(requested) ? requested : 300 * 2 ** attempt));
    await response.body?.cancel();
    onStatus({ status: "retrying", attempt: attempt + 1, reason: "http", httpStatus: response.status });
    await sleep(waitMs, undefined, { signal: init.signal });
  }
}
