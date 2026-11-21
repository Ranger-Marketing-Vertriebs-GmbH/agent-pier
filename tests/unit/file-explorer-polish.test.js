import test from "node:test";
import assert from "node:assert/strict";
import {
  archiveName,
  containsPath,
  outcomePath,
} from "../../web/features/files/file-action-utils.js";
import { followArchiveDownload } from "../../web/features/files/file-archive-download.js";
import {
  activityJob,
  editorOwnedJob,
} from "../../web/features/files/file-job-ownership.js";
import * as en from "../../web/lib/i18n/en/files.js";
import * as de from "../../web/lib/i18n/de/files.js";
import * as enLayout from "../../web/lib/i18n/en/explorer-layout.js";
import * as deLayout from "../../web/lib/i18n/de/explorer-layout.js";

test("a ZIP is named after its single entry or its folder", () => {
  assert.equal(archiveName([{ path: "/home/test/docs" }], "/home/test"), "docs.zip");
  assert.equal(archiveName([{ path: "/home/test/a.zip" }], "/home/test"), "a.zip");
  assert.equal(
    archiveName([{ path: "/home/test/a" }, { path: "/home/test/b" }], "/home/test"),
    "test.zip",
  );
  assert.equal(archiveName([{ path: "src/app" }], ""), "app.zip");
  assert.equal(archiveName([{ path: "/" }], "/"), "archive.zip");
  assert.equal(archiveName([{ path: "/" }, { path: "/x" }], "/"), "archive.zip");
});

test("job results name the source only when the entry went somewhere else", () => {
  assert.equal(
    outcomePath({ kind: "trash" }, { source: "/a/n.txt", path: "/a/n.txt" }),
    "/a/n.txt",
  );
  assert.equal(outcomePath({ kind: "rename" }, { path: "/a/m.txt" }), "/a/m.txt");
  assert.equal(
    outcomePath({ kind: "rename" }, { source: "/a/n.txt", path: "/a/m.txt" }),
    "/a/n.txt → /a/m.txt",
  );
  assert.equal(
    outcomePath(
      { kind: "archive" },
      { source: "/a/n.txt", path: "/a/n.txt", name: "a/n.txt" },
    ),
    "/a/n.txt → a/n.txt",
  );
  assert.equal(
    outcomePath({ kind: "restore" }, { source: "trash-id", path: "/a/n.txt" }),
    "/a/n.txt",
  );
});

test("the directory tree opens every folder on the way to the current one", () => {
  assert.equal(containsPath("/", "/home/test"), true);
  assert.equal(containsPath("/home", "/home/test"), true);
  assert.equal(containsPath("/home/test", "/home/test"), true);
  assert.equal(containsPath("/home/te", "/home/test"), false);
  assert.equal(containsPath("/var", "/home/test"), false);
  assert.equal(containsPath("", "src/app"), true);
  assert.equal(containsPath("src", "src/app"), true);
  assert.equal(containsPath("src", undefined), false);
});

test("editor saves stay out of Activity", () => {
  assert.equal(editorOwnedJob({ kind: "text_save" }), true);
  assert.equal(activityJob({ kind: "text_save" }), false);
  assert.equal(activityJob({ kind: "upload_group" }), false);
  assert.equal(activityJob({ kind: "rename" }), true);
});

function jobsStub(jobs) {
  const listeners = new Set();
  return {
    state: { jobs },
    getSnapshot() {
      return this.state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      this.state = { jobs: next };
      for (const listener of [...listeners]) listener();
    },
    archiveHref: (id) => `/api/files/jobs/${id}/download`,
    listeners,
  };
}

test("Download as ZIP saves the archive once its job completes", () => {
  const jobs = jobsStub([{ id: "a", status: "running" }]);
  const saved = [];
  followArchiveDownload(jobs, "a", (href) => saved.push(href));
  assert.deepEqual(saved, []);
  jobs.set([{ id: "a", status: "completed", artifactReady: true }]);
  jobs.set([{ id: "a", status: "completed", artifactReady: true }]);
  assert.deepEqual(saved, ["/api/files/jobs/a/download"]);
  assert.equal(jobs.listeners.size, 0);
});

test("a failed or cancelled ZIP job saves nothing and stops following", () => {
  const jobs = jobsStub([{ id: "a", status: "queued" }]);
  const saved = [];
  followArchiveDownload(jobs, "a", (href) => saved.push(href));
  jobs.set([{ id: "a", status: "failed" }]);
  assert.deepEqual(saved, []);
  assert.equal(jobs.listeners.size, 0);
  const stop = followArchiveDownload(jobs, "b", (href) => saved.push(href));
  stop();
  jobs.set([{ id: "b", status: "completed", artifactReady: true }]);
  assert.deepEqual(saved, []);
});

test("file counts use the singular for one", () => {
  for (const [copy, layout, one] of [
    [en.filesCopy, enLayout.explorerLayoutCopy, /\b1 (\w+ )?(entry|reference|byte)\b/],
    [de.filesCopy, deLayout.explorerLayoutCopy, /\b1 (\w+ )?(Eintrag|Verweis|Byte)\b/],
  ]) {
    for (const text of [
      copy.summary(1, 1),
      copy.scanned(1),
      copy.measuredSize(1),
      copy.actions.clipboard(1, "Copy"),
      copy.transfers.entries(1, null),
      copy.transfers.entries(1, 1),
      copy.transfers.omissionsCount(1),
      copy.transfers.retryCount(1),
      layout.entries(1),
    ])
      assert.match(text, one, text);
    assert.doesNotMatch(copy.actions.purgeConfirm(1, 1), /\b1 (frozen|festgehaltenen)/);
    // An unknown total stays explicit, without "of unknown entries".
    assert.match(copy.transfers.entries(1, null), /unknown|unbekannt/);
    assert.doesNotMatch(copy.transfers.entries(1, null), /of unknown|von unbekannt/);
    assert.doesNotMatch(copy.actions.usage("1 KB", 1), /\b1 (entries|Einträgen)\b/);
  }
});
