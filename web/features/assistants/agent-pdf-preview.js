// PDF files in the agent chat open as a page-by-page preview (AgentPdfPreview).

/** The most of a PDF the preview fetches and renders: 10 MiB. */
export const PDF_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

/** The most pixels one rendered page canvas may have: 4096 x 4096. */
export const MAX_CANVAS_PIXELS = 16_777_216;

const pdfName = /\.pdf$/i;
const media = new Set(["image", "video", "audio"]);

/** Whether a chat file is a PDF the chat can preview. */
export function isPdfAttachment(file) {
  if (!file || file.unavailable || media.has(file.kind)) return false;
  const type = String(file.type || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  return type === "application/pdf" || pdfName.test(String(file.name || ""));
}

/** Whether its recorded size is above the preview cap (unknown sizes are read capped). */
export function pdfTooLarge(file, max = PDF_PREVIEW_MAX_BYTES) {
  return Number.isFinite(file?.size) && file.size > max;
}

/**
 * Reads a response body as bytes, at most `max`: `{ data }`, or `{ tooLarge: true }`
 * as soon as the body passes the cap (the rest is not read).
 */
export async function readPdf(response, max = PDF_PREVIEW_MAX_BYTES) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel?.();
    return { tooLarge: true };
  }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length > max ? { tooLarge: true } : { data: bytes };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return { data };
}

/** The device scale `scale * ratio`, reduced so a width x height page stays under `max` pixels. */
export function canvasScale(width, height, scale, ratio, max = MAX_CANVAS_PIXELS) {
  const wanted = scale * ratio;
  const limit = Math.sqrt(max / (width * height));
  return Math.min(wanted, limit);
}
