import test from "node:test";
import assert from "node:assert/strict";
import { prepareArtifactDocument } from "../../web/features/artifacts/artifact-document.js";
const file = (path, mediaType, text) => ({
  path,
  mediaType,
  base64: Buffer.from(text).toString("base64"),
});
const snapshot = (html, more = []) => ({
  entrypoint: "index.html",
  files: [file("index.html", "text/html", html), ...more],
});
test("artifact document resolves bundled assets without trusting HTML in the parent", async () => {
  const result = await prepareArtifactDocument(
    snapshot(
      '<link rel="stylesheet" href="styles/main.css"><img src="picture.svg"><script src="main.js"></script>',
      [
        file(
          "styles/main.css",
          "text/css",
          "body { background-image: url(../picture.svg); }",
        ),
        file("picture.svg", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg"/>'),
        file("main.js", "text/javascript", 'document.body.dataset.loaded="yes";'),
      ],
    ),
  );
  assert.match(result.html, /Content-Security-Policy/);
  assert.match(result.html, /data:image\/svg\+xml;base64/);
  assert.match(result.html, /data:text\/javascript;base64/);
  assert.doesNotMatch(result.html, /src="main.js"/);
});
test("artifact document rejects external and escaped resource references", async () => {
  for (const url of [
    "https://example.com/a.js",
    "../a.js",
    "/api/accounts",
    "//example.com/a.js",
  ])
    await assert.rejects(
      prepareArtifactDocument(snapshot(`<script src="${url}"></script>`)),
      { code: "ARTIFACT_RESOURCE_UNSUPPORTED" },
    );
});
test("artifact modules rewrite static and literal dynamic imports with one import map", async () => {
  const result = await prepareArtifactDocument(
    snapshot('<script type="module" src="main.js"></script>', [
      file(
        "main.js",
        "text/javascript",
        'import { x } from "./dep.js"; import("./dep.js").then(() => x());',
      ),
      file("dep.js", "text/javascript", "export function x() {}"),
    ]),
  );
  assert.match(result.html, /type="importmap"/);
  assert.match(result.html, /artifact-module-0/);
});
test("repeated CSS dependency imports have a bounded expanded representation", async () => {
  const files = [];
  for (let i = 0; i < 12; i++)
    files.push(
      file(
        `s${i}.css`,
        "text/css",
        i === 11
          ? "body{color:red}"
          : `@import "s${i + 1}.css"; @import "s${i + 1}.css";`,
      ),
    );
  await assert.rejects(
    prepareArtifactDocument(snapshot('<link rel="stylesheet" href="s0.css">', files), {
      maxDocumentBytes: 65536,
    }),
    { code: "ARTIFACT_RESOURCE_UNSUPPORTED" },
  );
});

test("bundled SVG references preserve view and filter fragments", async () => {
  const result = await prepareArtifactDocument(
    snapshot(
      '<img src="picture.svg?version=1#view"><style>p{filter:url(picture.svg#blur)}</style>',
      [file("picture.svg", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ),
  );
  assert.match(result.html, /data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+#view/);
  assert.match(result.html, /data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+#blur/);
});

test("inline SVG image references resolve bundled files for href and xlink:href", async () => {
  const result = await prepareArtifactDocument(
    snapshot(
      '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><image href="picture.svg"/><image xlink:href="picture.svg"/></svg>',
      [file("picture.svg", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ),
  );
  assert.match(result.html, /<image href="data:image\/svg\+xml;base64,/);
  assert.match(result.html, /<image xlink:href="data:image\/svg\+xml;base64,/);
});
