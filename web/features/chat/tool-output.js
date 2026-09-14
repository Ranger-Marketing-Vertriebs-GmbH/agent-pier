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

// History providers combine arguments and results with a blank line. Decode only
// a complete, validated leading JSON value; never unescape arbitrary CLI output.
export function toolBlocks(source, toolName = "") {
  if (!source) return [];
  const shell = /^(bash|shell|command|exec_command|functions\.exec_command)$/i.test(
    toolName,
  );
  const language = (text) =>
    /^(@@|diff --git|\*\*\* Begin Patch|--- )/m.test(text) ? "diff" : "plaintext";
  const fallback = [
    {
      text: source,
      language: language(source) === "diff" ? "diff" : shell ? "bash" : "plaintext",
    },
  ];
  if (source.length > 262144) return fallback;
  const start = source.search(/\S/);
  if (!["{", "["].includes(source[start])) return fallback;
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
    if (depth !== 0) continue;
    const tail = source.slice(i + 1);
    if (tail && !/^\s/.test(tail)) return fallback;
    try {
      const value = JSON.parse(source.slice(start, i + 1));
      const file = fileLanguage(value.file_path || value.path || value.filePath);
      const blocks =
        Array.isArray(value) || !Object.keys(value).length
          ? [{ text: JSON.stringify(value, null, 2), language: "json" }]
          : Object.entries(value).map(([label, item]) => ({
              label,
              text: typeof item === "string" ? item : JSON.stringify(item, null, 2),
              language:
                typeof item !== "string"
                  ? "json"
                  : /^(cmd|command|script)$/.test(label)
                    ? "bash"
                    : /^(content|new_string|old_string|newString|oldString)$/.test(label)
                      ? file
                      : language(item),
            }));
      if (tail.trim())
        blocks.push({
          text: tail.replace(/^\r?\n\r?\n/, ""),
          language:
            language(tail) === "diff"
              ? "diff"
              : /^(read|read_file|readfile)$/i.test(toolName)
                ? file
                : language(tail),
        });
      return blocks;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function outputPreview(blocks, limit = 8) {
  let lines = limit,
    chars = limit === 8 ? 4000 : limit * 100;
  const visible = [];
  let truncated = false;
  for (const block of blocks) {
    if (lines <= 0 || chars <= 0) {
      truncated = true;
      break;
    }
    const rows = block.text.split("\n");
    const text = rows.slice(0, lines).join("\n").slice(0, chars);
    visible.push({ ...block, text });
    lines -= text.split("\n").length;
    chars -= text.length;
    if (text.length < block.text.length) {
      truncated = true;
      break;
    }
  }
  return { blocks: visible, truncated };
}
