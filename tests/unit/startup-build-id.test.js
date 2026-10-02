import test from "node:test";
import assert from "node:assert/strict";
import { startupPlugin } from "../../scripts/startup-plugin.mjs";

const document =
  '<!doctype html><html><head><title>A</title></head><body><div id="root"></div>' +
  '<script type="module" src="/assets/index-AAAAAAAA.js"></script></body></html>';

function build(lazyName) {
  const bundle = {
    "index.html": { source: document },
    "assets/index-AAAAAAAA.js": {},
    [`assets/${lazyName}.js`]: {},
  };
  startupPlugin().generateBundle.handler.call({ emitFile() {} }, {}, bundle);
  const source = String(bundle["index.html"].source);
  const id = /<meta name="agentpier-build" content="([a-f0-9]{16})">/.exec(source)?.[1];
  return { source, id };
}

test("the app document carries a build id in its head", () => {
  const { source, id } = build("Lazy-BBBBBBBB");
  assert.ok(id);
  assert.ok(source.indexOf("agentpier-build") < source.indexOf("</head>"));
});

test("the build id is stable and changes when only a lazy chunk changes", () => {
  assert.equal(build("Lazy-BBBBBBBB").id, build("Lazy-BBBBBBBB").id);
  assert.notEqual(build("Lazy-BBBBBBBB").id, build("Lazy-CCCCCCCC").id);
});
