import { parse, serialize } from "parse5";
import { prepareArtifactDocument } from "./artifact-document.js";
import { unsupported } from "./artifact-bundle.js";

const images = /^image\/(?:png|jpeg|gif|webp|avif|svg\+xml)$/;
const policy =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";
const html = "http://www.w3.org/1999/xhtml";
const cssData = /^data:text\/css;base64,([A-Za-z0-9+/=]*)$/;
// `@import "data:…"`, `@import url(data:…)` and `@import url("data:…") screen;`.
const cssImport =
  /@import\s+(?:url\(\s*)?(["']?)data:text\/css;base64,([A-Za-z0-9+/=]*)\1\s*\)?\s*([^;]*);/gi;

function decode(base64) {
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
}

// Imported sheets are bundled `data:` URLs; the frame's inherited policy does not load
// `data:` stylesheets, so they are inlined in order (media lists become @media).
function inlineImports(css, depth = 0) {
  if (depth > 16) return css;
  return css.replace(cssImport, (_match, _quote, base64, media) => {
    const nested = inlineImports(decode(base64), depth + 1);
    return media.trim() ? `@media ${media.trim()}{${nested}}` : nested;
  });
}

// Raw text in <style> is serialised verbatim: `<` must not end the element early.
export function previewStyleText(css) {
  return inlineImports(css).replaceAll("<", "\\3c ");
}

function children(node, visit) {
  for (const child of [...(node.childNodes || [])]) visit(child, node);
  if (node.content) children(node.content, visit);
}

function rewrite(node, parent) {
  const attr = (name) => node.attrs?.find((item) => item.name === name)?.value || "";
  const remove = () => parent.childNodes.splice(parent.childNodes.indexOf(node), 1);
  if (node.tagName === "script") return remove();
  if (node.tagName === "link") {
    const match = cssData.exec(attr("href"));
    if (!match || !/\bstylesheet\b/i.test(attr("rel"))) return remove();
    const style = {
      nodeName: "style",
      tagName: "style",
      namespaceURI: html,
      attrs: [],
      parentNode: parent,
      childNodes: [],
    };
    style.childNodes.push({
      nodeName: "#text",
      value: previewStyleText(decode(match[1])),
      parentNode: style,
    });
    parent.childNodes.splice(parent.childNodes.indexOf(node), 1, style);
    return undefined;
  }
  if (node.tagName === "style")
    for (const text of node.childNodes || [])
      if (text.nodeName === "#text") text.value = previewStyleText(text.value);
  children(node, rewrite);
  return undefined;
}

/**
 * A still picture of an artifact for the detail pane. It renders in an iframe with
 * `sandbox=""`, so scripts never run, and keeps the viewer's Content-Security-Policy.
 * A srcdoc frame also inherits the app's policy, which loads no `data:` stylesheets or
 * fonts: bundled CSS (and its imports) is inlined; bundled `data:` fonts stay blocked,
 * so the preview falls back to system fonts. Scripts are removed.
 */
export async function artifactPreviewDocument(snapshot) {
  const entry = snapshot.files?.find((file) => file.path === snapshot.entrypoint);
  if (!entry) throw unsupported();
  if (entry.mediaType !== "text/html") {
    if (!images.test(entry.mediaType)) throw unsupported();
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><style>html,body{margin:0;height:100%;background:#fff}body{display:grid;place-items:center}img{max-width:100%;max-height:100%;object-fit:contain}</style></head><body><img alt="" src="data:${entry.mediaType};base64,${entry.base64}"></body></html>`;
  }
  const prepared = await prepareArtifactDocument(snapshot);
  const document = parse(prepared.html);
  children(document, rewrite);
  return serialize(document);
}
