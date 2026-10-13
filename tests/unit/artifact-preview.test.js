import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "parse5";
import {
  artifactPreviewDocument,
  previewStyleText,
} from "../../web/features/artifacts/artifact-preview.js";

const file = (path, mediaType, text) => ({
  path,
  mediaType,
  base64: Buffer.from(text).toString("base64"),
});
const snapshot = (html, more = []) => ({
  entrypoint: "index.html",
  files: [file("index.html", "text/html", html), ...more],
});

function elements(node, found = []) {
  for (const child of node.childNodes || []) {
    if (child.tagName) found.push(child);
    elements(child, found);
  }
  if (node.content) elements(node.content, found);
  return found;
}

test("the preview keeps the artifact CSP first, drops scripts and inlines bundled CSS", async () => {
  const html = await artifactPreviewDocument(
    snapshot(
      '<link rel="stylesheet" href="main.css"><link rel="icon" href="main.css">' +
        '<h1 style="color: red">Report</h1><script>document.title="ran"</script>' +
        '<script type="module" src="app.js"></script><template><script>x()</script></template>',
      [
        file(
          "main.css",
          "text/css",
          '@import "extra.css" print; h1 { color: rgb(1, 2, 3); }',
        ),
        file("extra.css", "text/css", "p { margin: 0; }"),
        file("app.js", "text/javascript", "export const a = 1;"),
      ],
    ),
  );
  const nodes = elements(parse(html));
  const head = nodes.find((node) => node.tagName === "head");
  const first = head.childNodes.find((node) => node.tagName);
  assert.equal(first.tagName, "meta");
  assert.equal(
    first.attrs.find((a) => a.name === "http-equiv").value,
    "Content-Security-Policy",
  );
  assert.match(first.attrs.find((a) => a.name === "content").value, /default-src 'none'/);
  assert.equal(nodes.filter((node) => node.tagName === "script").length, 0);
  assert.equal(nodes.filter((node) => node.tagName === "link").length, 0);
  assert.doesNotMatch(html, /data:text\/(?:css|javascript)/);
  assert.match(html, /<style>.*rgb\(1, ?2, ?3\)/s);
  // The imported sheet is inlined with its media list.
  assert.match(html, /@media print\{p ?\{margin: ?0\}\}/);
});

test("inlined CSS cannot close its style element", async () => {
  const breakout = 'a { content: "</style><img src=x>"; } b { content: "\\3c /style>"; }';
  const html = await artifactPreviewDocument(
    snapshot('<link rel="stylesheet" href="x.css"><style>i{content:"</style>"}</style>', [
      file("x.css", "text/css", breakout),
    ]),
  );
  const nodes = elements(parse(html));
  assert.equal(nodes.filter((node) => node.tagName === "img").length, 0);
  assert.equal(html.match(/<\/style>/gi).length, 2);
  assert.equal(previewStyleText('a{content:"<"}'), 'a{content:"\\3c "}');
});

test("images preview as the picture, other entrypoints are unsupported", async () => {
  const png = { entrypoint: "a.png", files: [file("a.png", "image/png", "png")] };
  const html = await artifactPreviewDocument(png);
  assert.match(
    html,
    /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/,
  );
  assert.match(html, /<img alt="" src="data:image\/png;base64,cG5n">/);
  await assert.rejects(
    artifactPreviewDocument({
      entrypoint: "a.json",
      files: [file("a.json", "application/json", "{}")],
    }),
    { code: "ARTIFACT_RESOURCE_UNSUPPORTED" },
  );
  await assert.rejects(artifactPreviewDocument({ entrypoint: "x.html", files: [] }), {
    code: "ARTIFACT_RESOURCE_UNSUPPORTED",
  });
});
