import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { artifactFixture } from "../helpers/artifacts.js";
import { agentText } from "../../server/lib/i18n/agent-text.js";
import { messageIdentity } from "../../server/lib/i18n/message-identity.js";

test("artifact rejections identify the offending file and reason with translatable messages", async (t) => {
  const f = await artifactFixture(t);
  await fs.mkdir(path.join(f.workspace, "gallery"));
  await fs.writeFile(path.join(f.workspace, "gallery", "index.html"), "<h1>Gallery</h1>");
  await fs.writeFile(path.join(f.workspace, "gallery", "README.md"), "Notes");
  await fs.symlink("gallery/index.html", path.join(f.workspace, "link.html"));
  await fs.link(
    path.join(f.workspace, "gallery", "index.html"),
    path.join(f.workspace, "hard.html"),
  );
  await fs.writeFile(path.join(f.workspace, "über.html"), "<h1>test</h1>");
  const cases = [
    [
      { sourcePath: "gallery/README.md" },
      "ARTIFACT_UNSUPPORTED_FILE",
      /README.md/,
      /Unsupported file type/,
    ],
    [{ sourcePath: "link.html" }, "ARTIFACT_UNSAFE_FILE", /link.html/, /Symbolic links/],
    [{ sourcePath: "hard.html" }, "ARTIFACT_UNSAFE_FILE", /hard.html/, /hard links/],
    [{ sourcePath: "über.html" }, "ARTIFACT_INVALID_BUNDLE_PATH", /über.html/, /ASCII/],
    [
      { sourcePath: path.join(f.root, "outside.html") },
      "ARTIFACT_OUTSIDE_WORKSPACE",
      /Sitzungsverzeichnisses/,
      /outside the session workspace/,
    ],
    [
      { sourcePath: "gallery" },
      "ARTIFACT_INVALID_ENTRYPOINT",
      /Startdatei/,
      /entrypoint/,
    ],
  ];
  for (const [args, code, detail, english] of cases) {
    await assert.rejects(
      f.service.publish(
        f.context,
        { requestId: randomUUID(), title: "Gallery", ...args },
        async () => {},
      ),
      (error) => {
        assert.equal(error.code, code);
        assert.equal(error.status, 400);
        assert.match(error.message, detail);
        assert.match(agentText(error.message), english);
        assert.equal(messageIdentity(error.message).messageKey, `artifacts.${code}`);
        assert.ok(!error.message.includes(f.root));
        return true;
      },
    );
  }
  await fs.unlink(path.join(f.workspace, "hard.html"));
  await fs.unlink(path.join(f.workspace, "gallery", "README.md"));
  await assert.rejects(
    f.service.publish(
      f.context,
      {
        requestId: randomUUID(),
        title: "Gallery",
        sourcePath: "gallery",
        entrypoint: "missing.html",
      },
      async () => {},
    ),
    { code: "ARTIFACT_INVALID_ENTRYPOINT" },
  );
});
