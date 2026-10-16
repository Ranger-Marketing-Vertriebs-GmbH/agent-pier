// What install guides put where the owner's value belongs, and values that look like
// real credentials. Both only decide notes and empty required fields; nothing here
// decides security.
const placeholders = [
  /^$/,
  /^(?:…|\.\.\.)$/,
  /^<[^<>]+>$/,
  /^your[-_ ]/i,
  /[-_ ]here$/i,
  /^x{3,}$/i,
  /^changeme$/i,
  /^todo$/i,
];
const prefixes = /^(?:gh[pousr]_|github_pat_|sk-|sk_live_|xox[abprs]-|glpat-|AKIA)/;

export const isPlaceholder = (value) =>
  typeof value === "string" && placeholders.some((pattern) => pattern.test(value.trim()));

export function looksLikeToken(value) {
  const text = String(value ?? "")
    .trim()
    .replace(/^bearer\s+/i, "");
  if (prefixes.test(text) && text.length >= 16) return true;
  return /^[A-Za-z0-9+/=_-]{32,}$/.test(text) && /\d/.test(text) && /[A-Za-z]/.test(text);
}
