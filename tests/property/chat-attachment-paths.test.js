import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { check } from "../helpers/property.js";
import {
  ChatAttachments,
  attachmentDirectory,
} from "../../server/features/chat/chat-attachments.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzN8AAAAASUVORK5CYII=",
  "base64",
);

test("no client-supplied name can place an attachment outside its session directory", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-attachment-names-"));
  const directory = attachmentDirectory(dataDir, "account", "session");
  const store = new ChatAttachments({
    dataDir,
    sessions: {
      async get() {
        return { id: "session", status: "running", attachments: { directory } };
      },
    },
  });
  try {
    // check() is fc.assert(), which returns a promise for an asyncProperty.
    // Without the await this test would pass while asserting nothing.
    await check(
      fc.asyncProperty(fc.string({ maxLength: 300 }), async (name) => {
        fs.rmSync(directory, { recursive: true, force: true });
        let stored;
        try {
          stored = await store.store("session", { name, data: png.toString("base64") });
        } catch {
          return; // A rejected name stores nothing, which satisfies the property.
        }
        const resolved = path.resolve(stored.path);
        assert.equal(path.dirname(resolved), directory);
        assert.equal(resolved.startsWith(directory + path.sep), true);
      }),
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
