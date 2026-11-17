import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addedFolderScreen as parse,
  addedFolders,
} from "../../server/features/requests/claude-added-folder.js";
import { startupScreen } from "../../server/features/requests/claude-startup-prompts.js";
import { blockingScreen } from "../../server/features/clis/claude/tui.js";
import { addedFolderScreen } from "../fixtures/requests/claude-added-folder.js";

const folder =
  "/Users/owner/Library/Application Support/AgentPier/chat-attachments/a1/s1";
// Wrapped like the owner's 50-column terminal: at a space and inside a segment.
const wrapped =
  "/Users/owner/Library/Application Support/AgentPier/\n chat-attachments/a1/s1";

test("the --add-dir trust dialog is recognized for the session's own folder", () => {
  for (const selected of ["exit", "add"])
    assert.deepEqual(parse(addedFolderScreen(folder, { selected }), [folder]), {
      path: folder,
      selected,
    });
  assert.deepEqual(parse(addedFolderScreen(wrapped, { selected: "add" }), [folder]), {
    path: folder,
    selected: "add",
  });
  assert.ok(parse(addedFolderScreen("/long/my\n project/s1"), ["/long/my project/s1"]));
  assert.ok(parse(addedFolderScreen("/long/pro\n ject/s1"), ["/long/project/s1"]));
  // The hint after a refused confirmation, a repository line and a short window.
  for (const options of [{ held: true }, { repository: "/repo" }, { short: true }])
    assert.deepEqual(parse(addedFolderScreen(wrapped, options), [folder]), {
      path: folder,
      selected: "exit",
    });
});

test("another path, a quoted dialog or a changed menu is not the dialog", () => {
  assert.equal(parse(addedFolderScreen(folder), ["/elsewhere"]), null);
  assert.equal(parse(addedFolderScreen(folder), []), null);
  assert.equal(parse(addedFolderScreen("/long/my project"), ["/long/myproject"]), null);
  assert.equal(parse(addedFolderScreen("/long/myproject"), ["/long/my project"]), null);
  assert.equal(parse(addedFolderScreen(`${folder}/sub`), [folder]), null);
  // Indented transcript output never starts the dialog's own rule and heading.
  assert.equal(
    parse("Assistant:\n" + addedFolderScreen(folder).replace(/\n/g, "\n  ⎿  "), [folder]),
    null,
  );
  assert.equal(parse(addedFolderScreen(folder) + "\n❯ New composer", [folder]), null);
  assert.equal(
    parse(addedFolderScreen(folder).replace("Yes, add it", "Yes, move here"), [folder]),
    null,
  );
  assert.equal(
    parse(addedFolderScreen(folder).replace("No, exit", "No, leave it out"), [folder]),
    null,
  );
  // Both rows, or none, marked.
  assert.equal(
    parse(addedFolderScreen(folder).replace("   Yes, add it", " ❯ Yes, add it"), [
      folder,
    ]),
    null,
  );
  assert.equal(parse(addedFolderScreen(folder).replace("❯", " "), [folder]), null);
  assert.equal(
    parse(
      addedFolderScreen(folder).replace(
        "Claude Code'll be able to read, edit, and execute",
        "Claude may",
      ),
      [folder],
    ),
    null,
  );
});

test("startup and blocking screens show the dialog before and after the receipt", () => {
  const screen = addedFolderScreen(wrapped, { selected: "add" });
  for (const options of [{ started: false }, { started: true, sessionOnly: true }]) {
    const menu = startupScreen(screen, "/project", { ...options, folders: [folder] });
    assert.equal(menu.dialog, "addedFolder");
    assert.equal(menu.selected, "add");
    assert.equal(menu.path, folder);
    assert.deepEqual(
      menu.options.map((o) => o.id),
      ["exit", "add"],
    );
  }
  // Without its folder it stays an unknown startup menu, and nothing after the receipt.
  assert.equal(startupScreen(screen, "/project", { started: false }).dialog, "unknown");
  assert.equal(startupScreen(screen, "/project", { sessionOnly: true }), null);
  const session = { attachments: { directory: folder } };
  assert.equal(
    blockingScreen(screen, { cwd: "/project", started: true, session }).dialog,
    "addedFolder",
  );
  assert.equal(blockingScreen(screen, { cwd: "/project", started: true }), null);
});

test("a session's folders are its attachment folder and that folder's real path", (t) => {
  assert.deepEqual(addedFolders(undefined), []);
  assert.deepEqual(addedFolders({ attachments: null }), []);
  assert.deepEqual(addedFolders({ attachments: { directory: "/missing/s1" } }), [
    "/missing/s1",
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "added-folder-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "real"));
  fs.symlinkSync(path.join(root, "real"), path.join(root, "link"));
  assert.deepEqual(
    addedFolders({ attachments: { directory: path.join(root, "link") } }),
    [path.join(root, "link"), fs.realpathSync(path.join(root, "real"))],
  );
});
