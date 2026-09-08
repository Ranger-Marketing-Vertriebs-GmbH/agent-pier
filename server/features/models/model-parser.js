import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
const plain = (value) => stripVTControlCharacters(value).replaceAll("\u00a0", " ");
const digest = (value) => createHash("sha256").update(value).digest("hex").slice(0, 32);
// Preserve SGR emphasis: OpenCode marks the cursor with bold, not a text glyph.
function styledLines(raw) {
  let bold = false,
    dim = false,
    bg = null,
    fg = null;
  const lines = [{ text: "", cells: [] }];
  for (const token of raw.matchAll(/\x1b\[([\d;]*)m|([^\x1b])/gu)) {
    if (token[1] !== undefined) {
      const codes = token[1].split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        const n = codes[i];
        if (n === 38 || n === 48) {
          const length = codes[i + 1] === 2 ? 4 : 2;
          const color = codes.slice(i + 1, i + length + 1).join(";");
          if (n === 48) bg = color;
          else fg = color;
          i += length;
          continue;
        }
        if (n === 0) {
          bold = false;
          dim = false;
          bg = null;
          fg = null;
        }
        if (n === 1) bold = true;
        if (n === 2) dim = true;
        if (n === 22) {
          bold = false;
          dim = false;
        }
        if (n === 39) fg = null;
        if (n === 49) bg = null;
        if (n >= 40 && n <= 47) bg = String(n);
        if (n >= 100 && n <= 107) bg = String(n);
      }
    } else if (token[2] === "\n") lines.push({ text: "", cells: [] });
    else {
      const ch = token[2] === "\u00a0" ? " " : token[2];
      lines.at(-1).text += ch;
      lines.at(-1).cells.push({ ch, bold, dim, bg, fg });
    }
  }
  return lines;
}
export function parseModelPicker(tool, raw) {
  const lines = styledLines(raw);
  let start = -1,
    kind = "model";
  for (let i = 0; i < lines.length; i++) {
    const title = lines[i].text.trim();
    if (
      (tool === "claude" && title === "Select model") ||
      (tool === "codex" &&
        /^Select (?:Model(?: and Effort)?|Reasoning Level for .+)$/.test(title)) ||
      (tool === "opencode" && /\bSelect (?:model|variant)\s+esc\b/i.test(title))
    ) {
      start = i;
      kind = /Reasoning|variant/i.test(title) ? "effort" : "model";
    }
  }
  if (start < 0) return null;
  const title =
    tool === "opencode"
      ? lines[start].text.match(/\bSelect (?:model|variant)(?=\s+esc\b)/i)[0]
      : lines[start].text.trim();
  const options = [];
  let selected = null,
    current = null,
    searchQuery = "",
    emptyResults = false;
  if (tool === "opencode") {
    const left = lines[start].text.indexOf(title) - 2;
    const right = lines[start].text.lastIndexOf("esc") + 3;
    const titleOffset = lines[start].text.indexOf(title);
    const background = lines[start].cells[titleOffset]?.bg;
    const crop = (line) => line?.cells.slice(Math.max(0, left), right) || [];
    const search = crop(lines[start + 2])
      .map((c) => c.ch)
      .join("")
      .trim();
    if (kind === "model") searchQuery = search === "Search" ? "" : search;
    let category = "";
    for (let i = start + 4; i < lines.length; i++) {
      const content = crop(lines[i]);
      const text = content
        .map((c) => c.ch)
        .join("")
        .trim();
      if (
        background !== null &&
        lines[i].cells[Math.max(0, titleOffset - 4)]?.bg !== background
      )
        break;
      if (/^No results(?: found)?$/i.test(text)) {
        emptyResults = true;
        break;
      }
      if (
        /^(?:Connect provider|View all providers|Popular providers|Favorite\s+ctrl)/i.test(
          text,
        )
      )
        break;
      if (!text) continue;
      const bold = content.filter((c) => c.bold && c.ch.trim());
      const highlighted = bold.some((c) => c.bg !== background);
      if (bold.length && !highlighted) {
        category = /^(?:Recent|Favorites|Recommended)$/.test(text) ? "" : text;
        continue;
      }
      const marker = text.startsWith("●");
      const cleaned = text.replace(/^●\s*/, "");
      const [label, ...description] = cleaned.split(/\s{2,}/);
      if (!label || label === "Search") continue;
      const id = String(options.length);
      options.push({
        id,
        label,
        description: [category, ...description].filter(Boolean).join(" · "),
        current: marker,
      });
      if (highlighted) selected = id;
      if (marker && kind === "model") current = label;
    }
  } else {
    // The native dialog footer must be the last content on screen. A model menu
    // quoted in an assistant response still has the real composer below it.
    const footer = lines.findLast((line) => line.text.trim())?.text || "";
    if (
      !/enter to (?:confirm|set as default)/i.test(footer) ||
      !/esc to (?:cancel|go back)/i.test(footer)
    )
      return null;
    for (let i = start + 1; i < lines.length; i++) {
      const row = lines[i].text.match(/^\s*([❯›>]?)\s*(\d+)\.\s+(.+)$/);
      if (!row) continue;
      const [head, ...description] = row[3].split(/\s{2,}/);
      const marker = /✔|\(current\)/.test(head);
      const label = head
        .replace(/\s*[✔✓]/g, "")
        .replace(/\s*\(current\)/g, "")
        .trim();
      const id = String(options.length);
      options.push({
        id,
        label,
        description: description.join(" "),
        current: marker,
      });
      if (row[1]) selected = id;
      if (marker && kind === "model")
        current =
          description
            .join(" ")
            .match(/currently (.+?)\)\s*·/)?.[1]
            ?.replace(/\(1M context$/, "(1M context)") ||
          label.replace(/\s*\((?:default|recommended)\)/g, "");
    }
  }
  if ((!emptyResults && (!options.length || selected === null)) || options.length > 100)
    return null;
  return {
    title,
    kind,
    options,
    selected,
    currentModel: current,
    searchable: tool === "opencode" && kind === "model",
    searchQuery,
    selectKey:
      tool === "claude" && /s to use this session only/.test(plain(raw)) ? "s" : "Enter",
    signature: digest(
      JSON.stringify({
        title,
        kind,
        options,
        selected,
        searchQuery,
        raw: tool === "opencode" ? plain(raw).slice(0, 16000) : undefined,
      }),
    ),
  };
}
export function currentModel(tool, raw) {
  const text = plain(raw);
  if (tool === "claude") {
    const header = text
      .match(
        /(?:^|\n)[^\n]*?((?:Opus|Sonnet|Haiku|Fable) [^·\n]+)\s*·\s*(?:Claude|API)/,
      )?.[1]
      ?.trim();
    if (header) return header;
    const changes = [...text.matchAll(/(?:Set model to|Current model:)\s+([^\n]+)/g)];
    if (changes.length)
      return changes
        .at(-1)[1]
        .replace(/\s+(?:for this session only|with .+ effort).*$/, "")
        .trim();
    return null;
  }
  if (tool === "codex") {
    const changes = [
      ...text.matchAll(
        /(?:Model changed to|Switched to|Model:)\s+((?:gpt-|codex-|o[1-9](?:\s|[-.]))[^\n]*)/g,
      ),
    ];
    if (changes.length) return changes.at(-1)[1].trim();
    return (
      text
        .match(/model:\s+([^\n│]+)/i)?.[1]
        ?.replace(/\s+\/model.*/, "")
        .trim() || null
    );
  }
  if (tool === "opencode")
    return text.match(/┃\s+[^·\n]+·\s+([^\n┃]+)/)?.[1]?.trim() || null;
  return null;
}
export function modelPromptReady(tool, raw) {
  const text = plain(raw);
  const blocking =
    /Input disabled\.|Viewing sub-agent|waiting for approval|Do you (?:want|approve)|Enter to confirm/i;
  if (tool !== "codex" && blocking.test(text)) return false;
  if (tool === "opencode")
    return (
      /┃.+·/.test(text) &&
      /(?:ctrl\+p\s+commands|(?:^|\n)\s*esc\s+(?:again to )?interrupt\b)/.test(
        text.trimEnd(),
      ) &&
      !/\S[^\n]*\S[ \t]{2,}esc(?:\s|$)/m.test(text)
    );
  const lines = styledLines(raw);
  while (lines.length && !lines.at(-1).text.trim()) lines.pop();
  const index = lines.findLastIndex((line) => /^\s*[❯›](?:\s|$)/.test(line.text));
  const footerText = lines
    .slice(index + 1)
    .map((line) => line.text)
    .join("\n");
  const hasFooter =
    /(?:for shortcuts|context left|context window|gpt-|codex-|auto mode|manual mode)/i.test(
      footerText,
    ) ||
    (tool === "claude" &&
      /shift\+tab|bypass permissions|Opus|Sonnet|Haiku/i.test(footerText));
  if (index < 0 || index < lines.length - 10 || !hasFooter) return false;
  if (tool === "codex") {
    // Codex keeps prior command output above the composer. Only its current
    // status row and composer/footer can block opening the native picker.
    // /model is available during Codex tasks; an interrupt hint is not a blocker.
    let status = index - 1;
    while (status >= 0 && !lines[status].text.trim()) status--;
    const current = [
      lines[status]?.text || "",
      ...lines.slice(index).map((line) => line.text),
    ].join("\n");
    if (blocking.test(current)) return false;
  }
  if (tool === "claude") return true; // Alt+P preserves even a non-empty native draft.
  const prompt = lines[index];
  const offset = prompt.text.indexOf("›") + 1;
  // A newline at the start of a draft leaves the prompt row empty. Preserve
  // every continuation row up to the native footer before typing /model.
  const footer = lines.findLastIndex(
    (line, position) =>
      position > index &&
      /(?:for shortcuts|context left|context window|gpt-|codex-|auto mode|manual mode)/i.test(
        line.text,
      ),
  );
  const chars = [
    ...prompt.cells.slice(offset),
    ...lines.slice(index + 1, footer).flatMap((line) => line.cells),
  ].filter((x) => x.ch.trim());
  return chars.length === 0 || chars.every((x) => x.dim);
}
