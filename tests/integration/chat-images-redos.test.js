import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ChatImages } from "../../server/features/chat/chat-images.js";

const execute = promisify(execFile);
const moduleUrl = new URL("../../server/features/chat/chat-images.js", import.meta.url);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzN8AAAAASUVORK5CYII=",
  "base64",
);

test("malformed Markdown image destinations cannot stall transcript decoration", async () => {
  // A separate process makes the deadline enforceable even when the regex blocks
  // Node's event loop. The historical expression hangs on just 64 escape pairs.
  const source = `
    import assert from "node:assert/strict";
    import { ChatImages } from ${JSON.stringify(moduleUrl.href)};
    const images = new ChatImages({});
    const messages = await images.descriptors({ id: "fixture", cwd: "/tmp" }, {
      messages: [{ role: "assistant", text: "[](" + "\\\\!".repeat(64) }],
    });
    assert.deepEqual(messages[0].images, []);
  `;
  await execute(process.execPath, ["--input-type=module", "-e", source], {
    timeout: 3000,
    killSignal: "SIGKILL",
  });
});

test("Markdown image destinations preserve escaped spaces and parentheses", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-markdown-images-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  for (const name of ["image (final).png", "other image.png"])
    fs.writeFileSync(path.join(cwd, name), png);
  const images = new ChatImages({});
  const messages = await images.descriptors(
    { id: "fixture", cwd },
    {
      messages: [
        {
          role: "assistant",
          text: String.raw`![preview](image\ \(final\).png) and [second](other\ image.png "Title")`,
        },
      ],
    },
  );
  assert.deepEqual(
    messages[0].images.map((image) => image.fullPath),
    [path.join(cwd, "image (final).png"), path.join(cwd, "other image.png")],
  );
});
