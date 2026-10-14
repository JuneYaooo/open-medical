import { MATERIAL_CATEGORIES, autoClassifyMaterial } from "./material-classify.mjs";

// Group by manual or automatic category, newest document date first.
// Legacy uploads without a saved category use the same classifier.
export function groupMaterials(files = []) {
  files = files.map(autoClassifyMaterial);
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
