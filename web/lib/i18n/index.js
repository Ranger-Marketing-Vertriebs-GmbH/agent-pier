export const locale = "de-DE";
export const language = "de";
export function formatTimestamp(value) {
  return new Date(value).toLocaleString(locale);
}
export function normalizeSearch(value) {
  return String(value || "").toLocaleLowerCase(language);
}
