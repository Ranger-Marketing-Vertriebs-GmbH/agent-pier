import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { artifactFixture } from "../helpers/artifacts.js";

// artifact_publish never copies from AgentPier's data directory, whatever the
// session's folder and whatever the spelling: it is refused by device and inode on
// every folder from `/` to the source and on every folder the copy opens.
const firmlink = "/System/Volumes/Data";
const valid = async () => {};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const denied = { code: "ARTIFACT_ACCESS_DENIED", status: 403 };

async function setup(t) {
  const f = await artifactFixture(t);
  await f.service.ready;
  const attachments = path.join(f.dataDir, "chat-attachments", "a");
  await fs.mkdir(path.join(attachments, "site"), { recursive: true });
  await fs.writeFile(path.join(attachments, "photo.png"), png);
  await fs.writeFile(path.join(attachments, "site", "index.html"), "<h1>secret</h1>");
  await fs.writeFile(path.join(f.workspace, "report.html"), "<h1>ok</h1>");
  const publish = (cwd, sourcePath, extra = {}) =>
    f.service.publish(
      { ...f.context, cwd },
      { requestId: randomUUID(), title: "T", sourcePath, ...extra },
      valid,
    );
  return { ...f, attachments, publish };
}

test("a session at the data directory's parent or at / never publishes its files", async (t) => {
  const f = await setup(t);
  const fromRoot = path.relative(f.root, f.attachments);
  await assert.rejects(f.publish(f.root, `${fromRoot}/photo.png`), denied);
  await assert.rejects(
    f.publish(f.root, `${fromRoot}/site`, { entrypoint: "index.html" }),
    denied,
  );
  const fromSlash = path.relative("/", f.attachments);
  await assert.rejects(f.publish("/", `${fromSlash}/photo.png`), denied);
  // A session folder below the data directory.
  await assert.rejects(f.publish(path.join(f.attachments, "site"), "index.html"), denied);
  // A folder that holds the data directory.
  await assert.rejects(
    f.publish(path.dirname(f.root), path.basename(f.root), {
      entrypoint: "workspace/report.html",
    }),
    denied,
  );
  // Outside the data directory it still publishes.
  assert.ok((await f.publish(f.root, "workspace/report.html")).id);
});

test(
  "the data directory in another case or through the firmlink is refused too",
  {
    skip: process.platform !== "darwin" && "case and firmlink spellings are macOS cases",
  },
  async (t) => {
    const f = await setup(t);
    const photo = path.join(f.attachments, "photo.png");
    const spellings = [`${firmlink}${photo}`, photo.toUpperCase()].filter((p) =>
      existsSync(p),
    );
    assert.ok(spellings.length);
    for (const spelled of spellings) {
      await assert.rejects(f.publish("/", path.relative("/", spelled)), denied, spelled);
      const parent = path.dirname(path.dirname(path.dirname(spelled)));
      await assert.rejects(
        f.publish(parent, path.relative(parent, spelled)),
        denied,
        spelled,
      );
    }
  },
);
