// Model-looking prose is not an observation. Modern Codex renders its model in
// the live composer footer; older versions also have a boxed startup header.
const effort = "default|none|minimal|low|medium|high|xhigh|max|ultra";
const footerModel = new RegExp(`^(.+?) (${effort})$`);
const label = (value) => /^[A-Za-z0-9][A-Za-z0-9._/:\[\] ()-]{0,299}$/.test(value);

export function codexModelFooter(text) {
  const lines = text.trimEnd().split("\n");
  const prompt = lines.findLastIndex((line) => /^\s*›(?:\s|$)/.test(line));
  // Codex 0.160 prints a key hint ("? for shortcuts", "← for agents · …") below it.
  const last =
    lines.length -
    1 -
    (/^ {2}\S.*\bfor (?:shortcuts|agents)$/.test(lines.at(-1)) ? 1 : 0);
  if (
    prompt >= 0 &&
    last > prompt &&
    last - prompt <= 10 &&
    !lines[last - 1].trim() &&
    /^ {2}\S/.test(lines[last])
  ) {
    for (const field of lines[last].trim().split(/\s+·\s+/)) {
      const match = footerModel.exec(field);
      if (match && label(match[1]))
        return {
          index: last,
          model: match[2] === "default" ? match[1] : `${match[1]} ${match[2]}`,
        };
    }
  }

  return null;
}

export function currentCodexModel(text) {
  const footer = codexModelFooter(text);
  if (footer) return footer.model;
  const lines = text.trimEnd().split("\n");
  const prompt = lines.findLastIndex((line) => /^\s*›(?:\s|$)/.test(line));
  // A startup header left in scrollback ceases to be authoritative once a
  // conversation has started. Keep the controller's last confirmed model then.
  const title = lines.findLastIndex((line) => /^│\s*>_ OpenAI Codex\b/.test(line));
  if (title < 0 || !/^╭─+╮\s*$/.test(lines[title - 1] || "")) return null;
  const end = lines.findIndex((line, i) => i > title && /^╰─+╯\s*$/.test(line));
  if (end < 0 || end - title > 8) return null;
  if (
    lines
      .slice(end + 1, prompt < 0 ? undefined : prompt)
      .some((line) => /^\s*[›•]/.test(line))
  )
    return null;
  const box = lines.slice(title + 1, end);
  if (!box.every((line) => /^│.*│\s*$/.test(line))) return null;
  if (!box.some((line) => /^│\s*directory:\s*\S/.test(line))) return null;
  for (const line of box) {
    const match = /^│\s*model:\s*(.+?)\s+\/model\s+to change\s*│\s*$/.exec(line);
    if (match && label(match[1])) return match[1];
  }
  return null;
}
