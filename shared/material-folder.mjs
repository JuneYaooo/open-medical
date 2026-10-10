import { MATERIAL_CATEGORIES } from "./material-classify.mjs";

// Report-folder grouping: files bucketed by their confirmed category
// (suggestion shown when unset), newest document date first inside each
// bucket. Pure and shared so the UI and tests agree on ordering.
export function groupMaterials(files = []) {
  const fileDate = (file) => file.documentDate || String(file.createdAt || "").slice(0, 10) || "";
  return MATERIAL_CATEGORIES
    .map((category) => [
      category,
      files.filter((file) => (MATERIAL_CATEGORIES.includes(file.category) ? file.category : "其他") === category),
    ])
    .filter(([, grouped]) => grouped.length > 0)
    .map(([category, grouped]) => {
      grouped.sort((a, b) => fileDate(b).localeCompare(fileDate(a)) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      const dates = grouped.map(fileDate).filter(Boolean);
      return {
        category,
        files: grouped,
        count: grouped.length,
        dateRange: dates.length ? `${dates[dates.length - 1]} ~ ${dates[0]}` : "",
      };
    });
}
