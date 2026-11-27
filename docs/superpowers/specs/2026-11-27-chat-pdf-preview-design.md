# PDF preview in the agent chat — design

## Intent

The owner wants to read PDFs in the agent chat (shared by an agent or sent by
themselves) without downloading each one. Today a PDF is a chip with a download
button only.

## Goals

- Clicking a PDF's name opens a preview, the same way Markdown files do today
  (`AgentMarkdownPreview.jsx`): side panel on desktop, bottom sheet on phones,
  download button kept in the chip and in the panel footer.
- All pages, scrollable; zoom (fit width / + / −); works in the owner app and the
  user app, including the iOS home-screen app.

## Non-goals / anti-goals

- No PDF editing, annotations, forms, text search or printing.
- No loosening of the attachment security headers (`sandbox` CSP, octet-stream for
  non-inline types, no framing). A PDF must never run script on the app origin.
- No page navigation away from the app.

## Approaches

1. **pdf.js in the app (chosen by the owner).** Fetch the bytes from the signed-in
   attachment route, render pages to canvas with `pdfjs-dist`, lazily loaded on
   first open. Works everywhere, keeps headers unchanged; costs a ~1 MB dependency
   loaded on demand.
2. Browser PDF viewer in an iframe — rejected: needs framing and the sandbox CSP
   relaxed for PDFs, active content on the app origin, iOS frames often show only
   page one.

## Decisions (Claude's calls, correctable)

- `isPdfAttachment(file)`: type `application/pdf` or name `*.pdf`, not unavailable.
- Preview cap 10 MiB (= `MAX_ATTACHMENT_BYTES`); larger or failing files say so and
  keep the download, like the Markdown preview.
- pdf.js with scripting disabled, `isEvalSupported: false`, worker bundled by Vite
  from `'self'` so the app CSP stays as is; pages rendered lazily as they scroll in.
- Icon in the chip: a document icon for PDFs (existing icon set).
- New strings in `assistant-attachments` catalogs (de + en), confirmed in the lock.
- Docs: mention in the guide that covers chat attachments; component gallery only if
  a new reusable primitive emerges (expected: none, it reuses `SidePanel`).

## Left to the builder

- Exact pdf.js build (legacy vs modern) for Safari/WebKit support of the supported
  matrix; verify fonts and images render under the current CSP (no
  `wasm-unsafe-eval`; fall back to JS decoders if pdf.js wants wasm).
- Tests: unit for `isPdfAttachment`/cap, browser spec opening a fixture PDF and
  seeing page 2.
