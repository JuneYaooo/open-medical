export function scopeKey(path, platform = process.platform) {
  const normalized = path.replaceAll("\\", "/").normalize("NFC");
  // Conservative on platforms that commonly use case-insensitive volumes.
  return ["darwin", "win32"].includes(platform) ? normalized.toLowerCase() : normalized;
}
export function scopesOverlap(left, right) {
  const a = scopeKey(left), b = scopeKey(right);
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}
