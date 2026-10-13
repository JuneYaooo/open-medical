// Matrix cells are independent; each cell retains its own sequential learning history.
export async function runLearningCells(cells, concurrency, run) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12)
    throw new Error("--concurrency 须为 1–12 的整数");
  let next = 0;
  const results = new Array(cells.length);
  await Promise.all(
    Array.from({ length: Math.min(concurrency, cells.length) }, async () => {
      while (next < cells.length) {
        const index = next++;
        try {
          results[index] = {
            status: "fulfilled",
            value: await run(cells[index]),
          };
        } catch (error) {
          results[index] = { status: "rejected", reason: error };
        }
      }
    }),
  );
  return results;
}

// A slow model load can coincide with a closed localhost keep-alive socket.
// Retry read-only polling; mutations must never be replayed here.
export async function retryLearningRead(
  read,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof TypeError) || attempt >= 2) throw error;
      await wait(250 * 2 ** attempt);
    }
  }
}
