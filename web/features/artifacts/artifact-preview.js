import { prepareArtifactDocument } from "./artifact-document.js";
import { unsupported } from "./artifact-bundle.js";

const images = /^image\/(?:png|jpeg|gif|webp|avif|svg\+xml)$/;
const policy =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

function decode(base64) {
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
}

/**
 * A still picture of an artifact for the detail pane. It renders in an iframe with
 * `sandbox=""`, so scripts never run; a srcdoc frame inherits the app's policy, which
 * does not allow `data:` stylesheets, so bundled CSS is inlined and scripts removed.
 */
export async function artifactPreviewDocument(snapshot, parser = new DOMParser()) {
  const entry = snapshot.files?.find((file) => file.path === snapshot.entrypoint);
  if (!entry) throw unsupported();
  if (entry.mediaType !== "text/html") {
    if (!images.test(entry.mediaType)) throw unsupported();
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><style>html,body{margin:0;height:100%;background:#fff}body{display:grid;place-items:center}img{max-width:100%;max-height:100%;object-fit:contain}</style></head><body><img alt="" src="data:${entry.mediaType};base64,${entry.base64}"></body></html>`;
  }
  const prepared = await prepareArtifactDocument(snapshot);
  const document = parser.parseFromString(prepared.html, "text/html");
  for (const script of document.querySelectorAll("script")) script.remove();
  for (const link of document.querySelectorAll("link")) {
    const href = link.getAttribute("href") || "";
    const match = /^data:text\/css;base64,(.*)$/.exec(href);
    if (match && /\bstylesheet\b/i.test(link.getAttribute("rel") || "")) {
      const style = document.createElement("style");
      style.textContent = decode(match[1]);
      link.replaceWith(style);
    } else link.remove();
  }
  return `<!doctype html>${document.documentElement.outerHTML}`;
}
