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
