import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { fileApi } from "../../web/features/files/file-api.js";
import { createFileEditorStore } from "../../web/features/files/file-editor-store.js";
import { requestId } from "../../web/features/files/file-action-utils.js";

async function editorFixture(t, { truncateFirstReply = false } = {}) {
  const f = await applicationFixture(t);
  const nativeFetch = globalThis.fetch;
  const writes = [];
  // Supply only the relative-URL/cookie/origin facilities provided by a browser.
  // All requests go through the real authenticated application and text publisher.
  t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    const url = new URL(input, f.url);
    assert.equal(url.origin, f.url);
    const headers = new Headers(options.headers);
    headers.set("cookie", f.cookie);
    headers.set("origin", f.url);
    const response = await nativeFetch(url, { ...options, headers });
    if (options.method === "PUT" && url.pathname === "/api/files/text") {
      const result = await response.clone().json();
      writes.push({
        id: headers.get("x-file-request"),
        precondition: headers.get("if-match") ?? headers.get("if-none-match"),
        bytes: Buffer.from(options.body),
        status: response.status,
        result,
      });
      if (truncateFirstReply && writes.length === 1 && response.ok)
        return new Response("{", { status: 200 });
    }
    return response;
  });
  const client = fileApi({ kind: "global" });
  const context = await client.get("/context");
  return { ...f, client, context, writes, editor: createFileEditorStore() };
}

test("editor ordinary save and independent SaveAs use IDs accepted by the real text route", async (t) => {
  const f = await editorFixture(t);
  const source = path.join(f.home, "source.txt"),
    copy = path.join(f.home, "copy.txt");
  await fs.writeFile(source, "\uFEFFbefore\r\n");
  const tab = await f.editor.open(f.client, f.context.scopeId, source, f.context.limits);
  assert.ok(tab.document, tab.error?.message);
  f.editor.edit(tab.id, { text: "saved é\n" });
  const ordinary = await f.editor.save(tab.id);
  if (process.platform === "linux") {
    assert.equal(tab.document.readOnly, true);
    assert.equal(ordinary.status, "failed");
    assert.equal(ordinary.error.code, "FILE_READ_ONLY");
    assert.equal(f.writes.length, 0);
    await assert.rejects(
      f.client.saveText(source, new TextEncoder().encode("refused"), {
        scopeId: f.context.scopeId,
        requestId: requestId(),
        revision: tab.document.revision,
      }),
      { code: "FILE_METADATA_UNSUPPORTED" },
    );
    assert.equal(await fs.readFile(source, "utf8"), "\uFEFFbefore\r\n");
  } else {
    assert.equal(ordinary.status, "saved", ordinary.error?.code);
    assert.equal(f.writes[0].status, 200);
    assert.equal(f.writes[0].precondition, JSON.stringify(tab.document.revision));
    assert.equal(await fs.readFile(source, "utf8"), "\uFEFFsaved é\r\n");
  }
  const savedAs = await f.editor.saveAs(tab.id, copy, { revision: null });
  assert.equal(savedAs.status, "saved-as", savedAs.error?.code);
  assert.equal(f.writes.at(-1).status, 200);
  assert.equal(f.writes.at(-1).precondition, "*");
  assert.deepEqual(await fs.readFile(copy), Buffer.from("\uFEFFsaved é\r\n"));
  assert.equal(f.editor.getSnapshot().tabs[0].path, source);
});

test("a lost successful HTTP reply replays the same timestamped editor attempt without publishing twice", async (t) => {
  const f = await editorFixture(t, { truncateFirstReply: true });
  const source = path.join(f.home, "original.txt"),
    copy = path.join(f.home, "new.txt");
  await fs.writeFile(source, "\uFEFForiginal\r\n");
  await fs.link(source, source + ".hardlink");
  const tab = await f.editor.open(f.client, f.context.scopeId, source, f.context.limits);
  assert.equal(tab.document.readOnly, true);
  f.editor.edit(tab.id, { text: "attempt é\n" });
  const before = Date.now();
  const lost = await f.editor.saveAs(tab.id, copy);
  assert.equal(f.writes[0].status, 200, JSON.stringify(f.writes[0].result));
  assert.equal(lost.status, "failed");
  assert.equal(lost.error.code, "FILE_INVALID_RESPONSE");
  assert.deepEqual(await fs.readFile(copy), Buffer.from("\uFEFFattempt é\r\n"));
  const timestamp = Number(f.writes[0].id.split(":")[0]);
  assert.ok(timestamp >= before && timestamp <= Date.now());
  const originalResult = f.writes[0].result;
  await fs.writeFile(copy, "external later content");
  const replay = await f.editor.saveAs(tab.id, copy);
  assert.equal(replay.status, "saved-as", replay.error?.code);
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[0].id, f.writes[1].id);
  assert.deepEqual(f.writes[0].bytes, f.writes[1].bytes);
  assert.deepEqual(replay.result, originalResult);
  assert.equal(await fs.readFile(copy, "utf8"), "external later content");
  const jobs = (await f.client.get("/jobs")).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, "text_save");
  assert.equal(jobs[0].status, "completed");
  assert.equal(jobs[0].completedEntries, 1);
  f.editor.edit(tab.id, { text: "new explicit attempt\n" });
  assert.equal((await f.editor.saveAs(tab.id, copy + ".second")).status, "saved-as");
  assert.notEqual(f.writes[1].id, f.writes[2].id);
  assert.equal((await f.client.get("/jobs")).jobs.length, 2);
  assert.equal(await fs.readFile(source, "utf8"), "\uFEFForiginal\r\n");
  assert.equal(await fs.readFile(source + ".hardlink", "utf8"), "\uFEFForiginal\r\n");
});
