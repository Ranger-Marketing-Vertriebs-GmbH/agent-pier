import { getDocumentProxy } from "unpdf";
import { clipText } from "./mail-text.js";

// PDF text through unpdf's bundled PDF.js, without script evaluation, font loading or
// rendering. Runs only inside the extraction child process.

/** The text of pages 1..pdfPages, pages separated by a blank line. */
export async function pdfText(bytes, limits) {
  const pdf = await getDocumentProxy(new Uint8Array(bytes), {
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: true,
    verbosity: 0,
  });
  try {
    const pages = Math.min(pdf.numPages, limits.pdfPages);
    let text = "";
    for (let number = 1; number <= pages; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      page.cleanup();
      if (number > 1) text += "\n\n";
      for (const item of content.items)
        text += (item.str ?? "") + (item.hasEOL ? "\n" : "");
      if (text.length > limits.textChars) return clipText(text, limits.textChars);
    }
    return { text, truncated: pdf.numPages > pages };
  } finally {
    await pdf.loadingTask.destroy();
  }
}
