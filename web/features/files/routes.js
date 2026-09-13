const sorts = new Set(["name", "type", "size", "modifiedAt"]);
const directions = new Set(["asc", "desc"]);

export function readExplorerRoute(search) {
  const query = new URLSearchParams(search);
  const hasPage = query.has("page");
  const rawPage = query.get("page") ?? "";
  const validPage = /^[1-9]\d{0,5}$/.test(rawPage);
  const sort = query.get("sort") || "name";
  const direction = query.get("direction") || "asc";
  return {
    filePath: (query.get("path") || "").slice(0, 4096),
    file: (query.get("file") || "").slice(0, 4096),
    fileSort: sorts.has(sort) ? sort : "name",
    fileDirection: directions.has(direction) ? direction : "asc",
    fileHidden: query.get("hidden") === "1",
    fileFilter: (query.get("filter") || "").slice(0, 300),
    filePage: validPage ? Number(rawPage) : 1,
    filePageInvalid: hasPage && !validPage ? rawPage : null,
  };
}

export function explorerQuery(route) {
  const query = new URLSearchParams();
  if (route.filePath) query.set("path", route.filePath);
  if (route.file) query.set("file", route.file);
  if (route.fileSort && route.fileSort !== "name") query.set("sort", route.fileSort);
  if (route.fileDirection && route.fileDirection !== "asc")
    query.set("direction", route.fileDirection);
  if (route.fileHidden) query.set("hidden", "1");
  if (route.fileFilter) query.set("filter", route.fileFilter);
  if (route.filePageInvalid !== null && route.filePageInvalid !== undefined)
    query.set("page", String(route.filePageInvalid));
  else if (Number.isSafeInteger(route.filePage) && route.filePage > 1)
    query.set("page", String(route.filePage));
  return query.size ? `?${query}` : "";
}
