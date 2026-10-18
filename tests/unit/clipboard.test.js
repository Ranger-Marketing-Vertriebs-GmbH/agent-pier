import test from "node:test";
import assert from "node:assert/strict";
import { writeClipboard } from "../../web/lib/clipboard.js";

function withClipboard(clipboard, run) {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: clipboard,
    configurable: true,
  });
  return run().finally(() => delete globalThis.navigator.clipboard);
}

test("writeClipboard reports a successful write", () =>
  withClipboard(
    {
      written: "",
      async writeText(text) {
        this.written = text;
      },
    },
    async () => {
      assert.equal(await writeClipboard("npm run check"), true);
      assert.equal(globalThis.navigator.clipboard.written, "npm run check");
    },
  ));

test("writeClipboard reports a refused write and a missing API as false", async () => {
  await withClipboard(
    {
      async writeText() {
        throw new Error("NotAllowedError");
      },
    },
    async () => assert.equal(await writeClipboard("x"), false),
  );
  await withClipboard(undefined, async () =>
    assert.equal(await writeClipboard("x"), false),
  );
});
