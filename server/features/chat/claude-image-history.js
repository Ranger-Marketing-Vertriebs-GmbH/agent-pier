const blocks = (record) =>
  Array.isArray(record?.message?.content) ? record.message.content : [];
const prompt = (record) =>
  record?.type === "user" &&
  !record.isSidechain &&
  !record.isCompactSummary &&
  typeof record.promptId === "string" &&
  record.promptId;

export function claudeImageSources(record) {
  if (!prompt(record) || !record.isMeta || !record.turnCompanion) return null;
  const content = blocks(record);
  if (!content.length) return null;
  const paths = content.map((block) =>
    block?.type === "text"
      ? /^\[Image: source: (\/[^\r\n]+)\]$/.exec(block.text)?.[1]
      : null,
  );
  return paths.every(Boolean) ? paths : null;
}

const imageInput = (record) =>
  prompt(record) &&
  !record.isMeta &&
  record.origin?.kind === "human" &&
  blocks(record).some((block) => block?.type === "image");

// Keep a native image prompt and its source companion together across history pages.
export function claudeHistoryGroup(record) {
  return imageInput(record) || claudeImageSources(record)
    ? `claude-image-prompt:${record.promptId}`
    : String(record.message?.id || record.uuid);
}

/** Resolve only explicit source evidence for the same human prompt, never image labels alone. */
export function restoreClaudeImagePaths(records) {
  const sources = new Map();
  for (const record of records) {
    const paths = claudeImageSources(record);
    if (paths)
      sources.set(record.promptId, [...(sources.get(record.promptId) || []), ...paths]);
  }
  return records.map((record) => {
    if (!imageInput(record)) return record;
    const paths = sources.get(record.promptId);
    const content = blocks(record);
    const texts = content.filter((block) => block?.type === "text");
    const ids = record.imagePasteIds;
    if (
      !paths ||
      texts.length !== 1 ||
      !Array.isArray(ids) ||
      ids.length !== paths.length ||
      new Set(ids).size !== ids.length ||
      content.filter((block) => block?.type === "image").length !== paths.length
    )
      return record;
    const text = texts[0].text;
    if (typeof text !== "string") return record;
    const labels = [...text.matchAll(/\[Image #(\d+)\]/g)];
    if (
      labels.length !== ids.length ||
      labels.some((match, i) => Number(match[1]) !== ids[i])
    )
      return record;
    // Chat uploads append paths after the authored text. Claude substitutes numbered chips.
    const restored = [text.replace(/\[Image #\d+\]/g, "").trimEnd(), ...paths]
      .filter(Boolean)
      .join("\n");
    return {
      ...record,
      message: {
        ...record.message,
        content: content.map((block) =>
          block === texts[0] ? { ...block, text: restored } : block,
        ),
      },
    };
  });
}
