// Claude models can talk to the user between tool calls in "narration" blocks. The
// API sends them as `thinking` content blocks, and only their signature tells them
// apart from real reasoning: a protobuf whose field 2 holds field 1, whose string
// field 8 reads "narration" (real thinking reads "thinking"). Claude Code decodes the
// signature the same way and shows a narration block's text as the reply it is.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

function varint(bytes, start) {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < 10; i += 1) {
    const at = start + i;
    if (at >= bytes.length) return undefined;
    const byte = bytes[at];
    value += (byte & 127) * scale;
    if ((byte & 128) === 0) return { value, next: at + 1 };
    scale *= 128;
  }
  return undefined;
}

/** The bytes of length-delimited field `wanted`, or undefined on a malformed message. */
function field(bytes, wanted) {
  let found;
  let at = 0;
  while (at < bytes.length) {
    const key = varint(bytes, at);
    if (!key) return undefined;
    const wire = key.value % 8;
    const number = Math.floor(key.value / 8);
    at = key.next;
    if (wire === 0) {
      const skipped = varint(bytes, at);
      if (!skipped) return undefined;
      at = skipped.next;
    } else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else if (wire === 2) {
      const size = varint(bytes, at);
      if (!size || size.value > bytes.length - size.next) return undefined;
      at = size.next + size.value;
      if (number === wanted) found = bytes.subarray(size.next, at);
    } else return undefined;
    if (at > bytes.length) return undefined;
  }
  return found;
}

function signatureKind(signature) {
  if (typeof signature !== "string" || !signature) return undefined;
  const bytes = Buffer.from(signature, "base64");
  const outer = field(bytes, 2);
  const inner = outer && field(outer, 1);
  const kind = inner && field(inner, 8);
  return kind ? decoder.decode(kind) : undefined;
}

/** The text a narration block shows the user, or "" for any other block. */
export function claudeNarrationText(block) {
  if (block?.type !== "thinking" || typeof block.thinking !== "string") return "";
  if (!block.thinking.trim()) return "";
  try {
    return signatureKind(block.signature) === "narration" ? block.thinking : "";
  } catch {
    return "";
  }
}
