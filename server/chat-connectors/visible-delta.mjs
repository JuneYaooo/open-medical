// Screen OCR has no stable message IDs. Only remove a strong contiguous overlap;
// short repeated replies remain ambiguous and must stay available for review.
export function visibleDelta(previous, current) {
  if (!previous) return { text: current, gap: false, firstCapture: true };
  if (previous === current) return { text: '', gap: false };
  const before = previous.split('\n'), after = current.split('\n');
  for (let size = Math.min(before.length,after.length); size > 0; size--) {
    if (!before.slice(-size).every((line,i)=>line===after[i])) continue;
    const length = after.slice(0,size).join('\n').length;
    if ((size >= 2 && length >= 12) || length >= 24) return { text: after.slice(size).join('\n'), gap: false };
    break;
  }
  return { text: current, gap: true };
}
