// A suspended laptop or stopped process must not turn wall-clock time into a
// successful continuous-load claim. Allow scheduling jitter and slow checks.
export function checkSoakContinuity(previous, now, interval) {
  const gap = now - previous, limit = Math.max(300000, interval + 300000);
  if (gap < 0 || gap > limit) throw new Error(`Continuous soak interrupted: scheduling gap ${gap}ms (limit ${limit}ms)`);
  return gap;
}
