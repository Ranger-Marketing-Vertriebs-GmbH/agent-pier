const preferenceKey = "agentpier-language";
const listeners = new Set();
export let language = "de";
export let locale = "de-DE";

export function detectLanguage(saved, languages = []) {
  if (saved === "de" || saved === "en") return saved;
  for (const candidate of languages) {
    const base = String(candidate).toLowerCase().split("-")[0];
    if (base === "de" || base === "en") return base;
  }
  // Keep non-browser consumers deterministic; browsers default to English.
  return languages.length ? "en" : "de";
}
function browserStorage() {
  try {
    return globalThis.window?.localStorage;
  } catch {
    return undefined;
  }
}
export function setLanguage(next, options = {}) {
  if (next !== "de" && next !== "en") throw new Error("Unsupported language");
  const storage = options.storage ?? browserStorage();
  if (options.persist !== false) {
    try {
      storage?.setItem(preferenceKey, next);
    } catch {
      // A restricted browser can still change language for this visit.
    }
  }
  const document = options.document ?? globalThis.document;
  if (document?.documentElement) {
    document.documentElement.lang = next;
    document.title =
      next === "de"
        ? "AgentPier — Dein Terminal. Überall."
        : "AgentPier — Your terminal. Anywhere.";
    document
      .querySelector?.('meta[name="description"]')
      ?.setAttribute(
        "content",
        next === "de"
          ? "Dein persönlicher Arbeitsbereich für Codex, Claude Code und OpenCode."
          : "Your personal workspace for Codex, Claude Code, and OpenCode.",
      );
  }
  if (next === language) return;
  language = next;
  locale = next === "de" ? "de-DE" : "en-US";
  for (const listener of listeners) listener();
}
export function subscribeLanguage(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function getLanguage() {
  return language;
}
export function initializeLanguage(browser = globalThis.window) {
  if (!browser) return () => {};
  let saved;
  try {
    saved = browser.localStorage?.getItem(preferenceKey);
  } catch {
    // Language detection remains available without storage access.
  }
  const languages = browser.navigator.languages?.length
    ? browser.navigator.languages
    : [browser.navigator.language || "en"];
  setLanguage(detectLanguage(saved, languages), {
    persist: false,
    document: browser.document,
  });
  const changed = (event) => {
    if (event.key !== preferenceKey && event.key !== null) return;
    setLanguage(detectLanguage(event.newValue, languages), {
      persist: false,
      document: browser.document,
    });
  };
  browser.addEventListener("storage", changed);
  return () => browser.removeEventListener("storage", changed);
}

// Stable catalog references let non-React helpers resolve the current language too.
// Components subscribe at App/LoginGate so switching preserves their local state.
export function localizedCopy(german, english) {
  const nested = new Map();
  return new Proxy(
    { ...german },
    {
      get(target, key) {
        const current = language === "en" ? english : target;
        const value = current[key];
        if (value && typeof value === "object") {
          if (!nested.has(key)) nested.set(key, localizedCopy(target[key], english[key]));
          return nested.get(key);
        }
        return value;
      },
    },
  );
}
export function formatTimestamp(value) {
  return new Date(value).toLocaleString(locale);
}
export function formatNumber(value, options) {
  return new Intl.NumberFormat(locale, options).format(value);
}
export function normalizeSearch(value) {
  return String(value || "").toLocaleLowerCase(language);
}
