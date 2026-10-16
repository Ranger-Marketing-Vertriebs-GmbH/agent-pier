import { TOOL_TEXT_LIMIT } from "./tool-text.js";

// Shell output answering the user's own command (Claude bash mode, Codex `!cmd`).
const outputText = (text = "") => text.replace(/^(?:\r?\n)+/, "").trimEnd();
// Keep the newest output within one tool payload: larger rows are cut into head and
// tail for the browser (tool-text.js), which would break the JSON of the streams.
const tail = (text, length) => {
  let start = Math.max(0, text.length - length);
  const code = text.charCodeAt(start);
  if (start && code >= 0xdc00 && code <= 0xdfff) start++;
  return text.slice(start);
};
/** Streams as one JSON tool payload plus the bytes omitted per stream. */
export function shellOutput(streams) {
  const full = Object.fromEntries(
    Object.entries(streams)
      .map(([name, text]) => [name, outputText(text)])
      .filter(([, text]) => text),
  );
  // Streams share the budget fairly by kept length. JSON escapes can expand text up
  // to six times (ANSI colours), so search the largest share whose JSON still fits.
  const names = Object.keys(full).sort((a, b) => full[a].length - full[b].length);
  const fit = (budget) => {
    const kept = {};
    let remaining = budget;
    names.forEach((name, index) => {
      const take = Math.min(
        full[name].length,
        Math.floor(remaining / (names.length - index)),
      );
      kept[name] = tail(full[name], take);
      remaining -= take;
    });
    // A stream left without room is dropped; its size still counts as omitted.
    return JSON.stringify(
      Object.fromEntries(Object.entries(kept).filter(([, text]) => text)),
    );
  };
  let content = JSON.stringify(full);
  if (content.length > TOOL_TEXT_LIMIT) {
    let low = 0;
    let high = Math.min(
      TOOL_TEXT_LIMIT,
      names.reduce((sum, name) => sum + full[name].length, 0),
    );
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fit(middle).length <= TOOL_TEXT_LIMIT) low = middle;
      else high = middle - 1;
    }
    content = fit(low);
  }
  const kept = JSON.parse(content);
  const omitted = Object.fromEntries(
    Object.entries(full)
      .map(([name, text]) => [
        name,
        Buffer.byteLength(text) - Buffer.byteLength(kept[name] || ""),
      ])
      .filter(([, bytes]) => bytes > 0),
  );
  return { content: content === "{}" ? "" : content, omitted };
}
