export function scopeKey(path, platform = process.platform) {
  const normalized = posixRelative(path);
  // Conservative on platforms that commonly use case-insensitive volumes.
  return ["darwin", "win32"].includes(platform) ? normalized.toLowerCase() : normalized;
}
// Canonical comparison form for workspace-relative paths: separators are
// unified (`\` on Windows, `/` elsewhere) and text is NFC-normalized so
// equivalent spellings compare equal. This is a comparison key only — the
// real on-disk path from path/realpath checks is never rewritten.
export function posixRelative(path) {
  return path.replaceAll("\\", "/").normalize("NFC");
}
export function scopesOverlap(left, right) {
  const a = scopeKey(left), b = scopeKey(right);
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}
// Unidirectional containment: `path` is `scope` itself or inside it. A scope
// entry never covers its parent, so scopes cannot widen through this helper.
export function scopeCovers(scope, path) {
  const a = scopeKey(scope), b = scopeKey(path);
  return a === b || b.startsWith(a + "/");
}
