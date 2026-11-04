const languages = new Map(
  Object.entries({
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    json: "json",
    sh: "bash",
    bash: "bash",
    css: "css",
    html: "xml",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
  }),
);
export const fileLanguage = (path) =>
  languages.get(typeof path === "string" ? path.split(".").at(-1).toLowerCase() : "") ||
  "plaintext";
