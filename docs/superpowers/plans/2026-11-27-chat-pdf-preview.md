# PDF Preview in the Agent Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Selecting a PDF's name in the agent chat opens a scrollable, zoomable preview in a side panel instead of forcing a download.

**Architecture:** Mirror the existing Markdown preview (`agent-markdown-preview.js`, `useMarkdownFile.js`, `AgentMarkdownPreview.jsx`): a pure helper module decides which files qualify, a hook fetches the bytes from the signed-in attachment route (without `download=1`) and opens them with `pdfjs-dist`, loaded through a dynamic `import()` on first open, and a `SidePanel` component renders each page to a canvas as it scrolls into view.

**Tech Stack:** React 19 + Vite, `pdfjs-dist` (new), `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-27-chat-pdf-preview-design.md`

## Global Constraints

- Server attachment headers stay unchanged (`server/http/routes/assistant-attachments.js` `sendAttachment`, `server/http/security.js` CSP). No `wasm-unsafe-eval`, no framing, no `object-src`.
- pdf.js runs without scripting and with `isEvalSupported: false`. Its worker is bundled by Vite and served from `'self'`.
- `pdfjs-dist` is pinned to an exact version published at least 14 days ago, loaded only by dynamic `import()`, never in the main chunk.
- Preview cap: `PDF_PREVIEW_MAX_BYTES = 10 * 1024 * 1024`.
- German and English strings in `web/lib/i18n/{de,en}/assistant-attachments.js` with matching keys. Run `npm run i18n:confirm -- assistant-attachments` and commit `translation-lock.json`.
- UI rules from `docs/ui-guide.md`: no new hex colours, no font size below 11px, breakpoints only from `web/lib/breakpoints.js`, reuse `SidePanel`, `Icon` and `button` classes. Files stay at or below 600 lines.
- Works the same in the owner app and in the user app. Both go through `AgentMessageAttachments.jsx` and `useAgentPaths`.

## Review Focus

1. **Huge pages or high zoom on phones:** iOS Safari blanks canvases above ~16.7 Mpx. Clamp each canvas to `MAX_CANVAS_PIXELS = 16_777_216` and scale the CSS size instead. Task 1 gets a unit test for `canvasScale`.
2. **Closing or switching files mid-render:** a closed panel must cancel the render tasks and `destroy()` the loading task and the document, without leaving a console error. Task 2's browser spec closes during load and asserts no page errors.
3. **Encrypted or broken PDFs:** a password prompt or a parse error shows the existing `previewFailed` message, keeps **Download**, and never hangs on "Loading". Task 2's browser spec serves garbage bytes.
4. **Fonts and images under the app CSP:** non-embedded standard fonts and JPX/JBIG2 images must render, or degrade without errors, without any CSP change. Task 2 serves `standardFontDataUrl` (and `wasmUrl` only if it works without wasm-eval; otherwise `useWasm: false`) from Vite-copied assets, and its spec watches for CSP violations.
5. **A file without a recorded size, larger than the cap:** stop reading at the cap the same way `readMarkdown` does. Task 1 owns `readPdf(response, max)` with a test.

---

### Task 1: PDF helpers

**Files:**
- Create: `web/features/assistants/agent-pdf-preview.js`
- Test: `tests/unit/agent-pdf-preview.test.js`

**Interfaces:**
- Produces:
  - `PDF_PREVIEW_MAX_BYTES: number` (10 MiB)
  - `MAX_CANVAS_PIXELS: number` (16 777 216)
  - `isPdfAttachment(file) -> boolean`: true when not `unavailable`, `kind` is not image/video/audio, and the type (before `;`, lowercased) is `application/pdf` or the name matches `/\.pdf$/i`
  - `pdfTooLarge(file, max = PDF_PREVIEW_MAX_BYTES) -> boolean`: true only for a finite `size` above `max`
  - `readPdf(response, max = PDF_PREVIEW_MAX_BYTES) -> Promise<{ data: Uint8Array } | { tooLarge: true }>`: same streaming and cap logic as `readMarkdown`, but collects bytes
  - `canvasScale(width, height, scale, ratio, max = MAX_CANVAS_PIXELS) -> number`: the device scale `scale * ratio`, reduced so that `width*height*s*s <= max`

- [ ] **Step 1: Write the failing tests**

Model them on `tests/unit/agent-markdown-preview.test.js`:
- `isPdfAttachment`: `report.pdf` with type `application/pdf` is true; `REPORT.PDF` with octet-stream is true; `x` with `application/pdf; charset=binary` is true; `notes.md` is false; `{ unavailable: true, name: "a.pdf" }` is false; `{ kind: "image", name: "a.pdf" }` is false.
- `pdfTooLarge`: size `10*1024*1024` is false, `+1` is true, `undefined` is false.
- `readPdf`: a Response with a body of 3 bytes gives `data` with length 3; a Response with header `content-length: 20` and max 10 gives `{ tooLarge: true }`; a streamed 12-byte body without content-length and max 10 gives `{ tooLarge: true }`.
- `canvasScale(612, 792, 1, 2)` equals `2`; `canvasScale(10000, 10000, 3, 3)` satisfies `10000*10000*s*s <= MAX_CANVAS_PIXELS` and `s > 0`.

- [ ] **Step 2: Run to verify the tests fail**

Run: `node --test tests/unit/agent-pdf-preview.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the module** with the signatures above.

- [ ] **Step 4: Run to verify the tests pass**

Run: `node --test tests/unit/agent-pdf-preview.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/features/assistants/agent-pdf-preview.js tests/unit/agent-pdf-preview.test.js
git commit -m "feat: recognise PDF attachments the chat can preview"
```

### Task 2: PDF preview panel, wiring, strings, docs

**Files:**
- Modify: `package.json`, `package-lock.json` (add `pdfjs-dist`, exact version)
- Create: `web/features/assistants/pdf-document.js`: lazy loader
- Create: `web/features/assistants/usePdfDocument.js`
- Create: `web/features/assistants/AgentPdfPreview.jsx`
- Modify: `web/features/assistants/agent-attachments.css` (page list and zoom bar styles)
- Modify: `web/features/assistants/AgentMessageAttachments.jsx`
- Modify: `web/lib/i18n/en/assistant-attachments.js`, `web/lib/i18n/de/assistant-attachments.js`, `web/lib/i18n/translation-lock.json`
- Modify: `vite.config.js` only if the standard-font or wasm assets need copying
- Create: `tests/fixtures/two-pages.pdf` (two pages, the text "Page one" and "Page two", Helvetica non-embedded, under 4 KB)
- Create: `tests/browser/assistant-chat-pdf-preview.spec.js`
- Modify: `docs/agents.md` (the chat-attachments paragraph near the Markdown preview, around line 2226)

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces:
  - `loadPdf(data: Uint8Array) -> Promise<{ document, destroy() }>` in `pdf-document.js`. It does `await import("pdfjs-dist")`, sets `GlobalWorkerOptions.workerSrc` from `new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)` (or the legacy build, see Step 3), and calls `getDocument({ data, isEvalSupported: false, enableXfa: false, standardFontDataUrl, ... })`.
  - `usePdfDocument(src, file) -> { loading } | { tooLarge } | { failed } | { document }`. Same lifecycle as `useMarkdownFile`: fetch with `credentials: "same-origin"`, wrapped in `observeBuild`, aborted on unmount, `destroy()` on unmount or when `src` changes.
  - `AgentPdfPreview({ file, src, details, limit, opener, close })`, with the same props as `AgentMarkdownPreview`.
- New copy keys (en / de):
  - `pdfPages: (count) => "{count} pages"` / `"{count} Seiten"` (singular form `1 page` / `1 Seite`)
  - `pdfPage: (n, count) => "Page {n} of {count}"` / `"Seite {n} von {count}"`, the aria label of each canvas
  - `zoomIn: "Zoom in"` / `"Vergrößern"`, `zoomOut: "Zoom out"` / `"Verkleinern"`, `zoomFit: "Fit width"` / `"An Breite anpassen"`
  - Reuse `preview`, `previewDownload`, `previewLoading`, `previewFailed`, `previewTooLarge`.

- [ ] **Step 1: Write the failing browser spec** `tests/browser/assistant-chat-pdf-preview.spec.js`

Copy the setup of `tests/browser/assistant-chat-markdown-preview.spec.js` (`chatFixture`, `userAppFixture`, `track`, `serve` with `page.route`), with shared files `file("pdf", "report.pdf", <fixture size>, "application/pdf", "document")`, `file("bigpdf", "scan.pdf", 11*1024*1024, "application/pdf", "document")` and `file("bad", "broken.pdf", 20, "application/pdf", "document")`. Serve the fixture bytes for `pdf` and `"not a pdf at all"` for `bad`. Tests:
- "a shared PDF opens in a side panel with all its pages": click the button named `Preview report.pdf`. The dialog titled `report.pdf` shows `2 pages`. Two canvases are labelled `Page 1 of 2` and `Page 2 of 2`; after scrolling, page 2 has non-zero width. The request list contains `pdf` without `download=1`. The footer link `Download` points to `…?download=1`. Esc closes the panel and focus returns to the opener.
- "zoom changes the page width": the width of `Page 1 of 2` grows after `Zoom in` and returns after `Fit width`.
- "a PDF over 10 MB says so and keeps the download": open `scan.pdf`. It shows the `previewTooLarge` text with `10 MB`, and no request for `bigpdf` is made.
- "a broken PDF shows the failure and keeps the download": open `broken.pdf`. It shows `previewFailed`.
- "closing while loading leaves no errors": delay the route for `pdf` by 500 ms, open the panel, press Esc, and assert that `page.on("pageerror")` and the console errors (CSP violations included) stay empty during the whole spec file.
- "the user app previews PDFs too": the same open-and-see-2-pages check through `userAppFixture`.
- A phone-viewport project run (existing config) sees the bottom sheet with page 1 visible.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && npx playwright test tests/browser/assistant-chat-pdf-preview.spec.js --project=chromium`
Expected: FAIL, no `Preview report.pdf` button.

- [ ] **Step 3: Add the dependency and the loader**

`npm install --save-exact pdfjs-dist@<latest version published at least 14 days ago>`. Pick the modern or legacy build by the supported WebKit/Safari range in `docs/` and the Playwright WebKit project. Use legacy if the modern build needs APIs the oldest supported Safari lacks. Implement `loadPdf` as specified. Serve `standard_fonts/` (and the wasm directory only if it works without `wasm-unsafe-eval`; otherwise pass `useWasm: false`) as Vite-copied assets under `/assets/pdfjs/`, and pass their URLs.

- [ ] **Step 4: Implement `usePdfDocument` and `AgentPdfPreview`**

The panel structure matches `AgentMarkdownPreview` (`SidePanel` with `title`, `subtitle={details}`, footer download `FileLink`). The body has a small toolbar (`Zoom out`, `Fit width`, `Zoom in` as `icon-button`s; reuse existing icons or add `zoom-in`/`zoom-out` to `Icon.jsx` and the gallery if none fit), the page count, and a list of pages. Each page gets a placeholder sized from `page.getViewport({ scale })`, and an `IntersectionObserver` renders it when visible, with `canvasScale` for the backing store and the render task cancelled on unmount. Fit width means the scale at which the page fills the panel's content width. Zoom steps are ×1.25, clamped to `[fit * 0.5, fit * 4]`.

- [ ] **Step 5: Wire it in `AgentMessageAttachments.jsx`**

In the chip branch, `isPdfAttachment(file)` gives `onOpen` → `setOpen({ file, opener, pdf: true })`. Render `<AgentPdfPreview … limit={fileSize(PDF_PREVIEW_MAX_BYTES)} />` when `open?.pdf`, and keep `ImageViewer` for the remaining case (`open && !open.markdown && !open.pdf`). Load `AgentPdfPreview` with `React.lazy` so pdf.js stays out of the chat chunk. Update the component's header comment.

- [ ] **Step 6: Strings, translation lock, docs**

Add the keys to both catalogs, run `npm run i18n:confirm -- assistant-attachments`, and check them in English in the browser. Extend the `docs/agents.md` paragraph: "Select the name of a PDF to read it in the same panel: every page, scrolling, **Zoom in**, **Zoom out** and **Fit width**; the preview reads PDFs up to 10 MB, and a larger file, or one that cannot be opened, offers the download instead. Scripts inside a PDF never run." Check `README.md` / `README.de.md` for an attachment feature list and add PDF preview where Markdown preview is listed (if it is not listed, leave them).

- [ ] **Step 7: Run to verify everything passes**

Run: `npm run build && npx playwright test tests/browser/assistant-chat-pdf-preview.spec.js tests/browser/assistant-chat-markdown-preview.spec.js --project=chromium`, then once with `--project=webkit`.
Expected: all pass. Then `npm run check`. Expected: green, including `ui-guide-rules`, the catalog parity and translation-lock tests, and `check:structure`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: preview PDFs in the agent chat"
```

### Task 3: Cleanup before the PR

- [ ] Delete `docs/superpowers/specs/2026-11-27-chat-pdf-preview-design.md` and this plan, then commit (`chore: remove PDF preview plan and spec`).
- [ ] Open the PR with screenshots (desktop panel, phone sheet) uploaded to the agent-pier-assets repo, listing `docs/agents.md` and the READMEs as checked docs.
