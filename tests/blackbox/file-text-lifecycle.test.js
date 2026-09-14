import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { applicationFixture, fixtureFetch } from "../helpers/application.js";
import { uploadRequest } from "../helpers/file-uploads.js";

async function attempt(f, target) {
  const context = await (await f.request("/api/files/context")).json();
  return {
    url: `${f.url}/api/files/text?${new URLSearchParams({ path: target })}`,
    headers: {
      cookie: f.cookie,
      origin: f.url,
      "content-type": "text/plain;charset=utf-8",
      "x-file-scope": context.scopeId,
      "x-file-request": uploadRequest(),
      "if-none-match": "*",
    },
  };
}
async function until(condition) {
  for (let n = 0; n < 500; n++) {
    if (await condition()) return;
    await delay(10);
  }
  assert.fail("fixture text owner did not settle");
}

test("lost actual HTTP response joins completed service work and replays the original pair after restart and external edit", async (t) => {
  const f = await applicationFixture(t),
    target = path.join(f.home, "lost"),
    canary = "private-text-canary-🧭-80556";
  let files = f.application.files;
  const request = await attempt(f, target),
    write = files.text.write.bind(files.text),
    gate = Promise.withResolvers(),
    entered = Promise.withResolvers();
  let publications = 0,
    saved;
  const run = files.publisher.native.run.bind(files.publisher.native);
  files.publisher.native.run = async (op, args) => {
    if (["exchange", "renameNoReplace"].includes(op)) publications++;
    return run(op, args);
  };
  files.text.write = async (args) => {
    saved = await write(args);
    entered.resolve();
    await gate.promise;
    return saved;
  };
  const controller = new AbortController();
  const pending = fixtureFetch(request.url, {
    method: "PUT",
    headers: request.headers,
    body: canary,
    signal: controller.signal,
  }).catch((error) => error);
  try {
    await entered.promise;
    controller.abort();
    await pending;
    gate.resolve();
    await until(() => files.jobs.active.size === 0);
    assert.equal(publications, 1);
    assert.equal(await fs.readFile(target, "utf8"), canary);
    const job = files.jobs.list(await files.context()).jobs[0];
    assert.equal(job.kind, "text_save");
    assert.equal(job.uploadGroupId, undefined);
    assert.equal((await f.request(`/api/files/jobs/${job.id}/retry`)).status, 409);
    const retry = await f.request(`/api/files/jobs/${job.id}/retry`, {
      method: "POST",
      headers: { "x-file-scope": request.headers["x-file-scope"] },
      body: { requestId: uploadRequest(), reference: `r1:${"a".repeat(64)}` },
    });
    assert.equal(retry.status, 409);
    const operation = files.store.getOperation(job.id);
    const forged = await f.request("/api/files/operations", {
      method: "POST",
      headers: { "x-file-scope": request.headers["x-file-scope"] },
      body: { ...operation, requestId: uploadRequest() },
    });
    assert.equal(forged.status, 400);
    const privateMetadata = JSON.stringify([
      files.store.db.prepare("SELECT operation,document FROM jobs").all(),
      files.store.db.prepare("SELECT document FROM job_entries").all(),
      files.store.db.prepare("SELECT document FROM publications").all(),
    ]);
    for (const forbidden of [canary, Buffer.from(canary).toString("base64")])
      assert.equal(privateMetadata.includes(forbidden), false);
    const publicData = JSON.stringify([
      job,
      await (await f.request(`/api/files/jobs/${job.id}/entries`)).json(),
      await (await f.request("/api/audit")).json(),
    ]);
    assert.equal(publicData.includes(canary), false);
    assert.equal(publicData.includes("p1:"), false);
    assert.equal(publicData.includes("textSave"), false);
    await fs.writeFile(target, "external writer");
    await f.restart();
    files = f.application.files;
    const current = await attempt(f, target);
    current.headers["x-file-request"] = request.headers["x-file-request"];
    const replay = await fixtureFetch(current.url, {
      method: "PUT",
      headers: current.headers,
      body: canary,
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), saved);
    for (const changed of [
      { body: canary + "!" },
      { url: current.url + "x" },
      {
        headers: {
          ...current.headers,
          "if-none-match": undefined,
          "if-match": JSON.stringify(saved.revision),
        },
      },
    ]) {
      const headers = { ...current.headers, ...changed.headers };
      if (changed.headers) delete headers["if-none-match"];
      const response = await fixtureFetch(changed.url || current.url, {
        method: "PUT",
        headers,
        body: changed.body || canary,
      });
      assert.equal(response.status, 409);
      const error = await response.json();
      assert.equal(error.code, "FILE_REQUEST_CONFLICT");
      assert.equal(JSON.stringify(error).includes(canary), false);
    }
    assert.equal(files.store.listPublications().length, 1);
    assert.equal(await fs.readFile(target, "utf8"), "external writer");
  } finally {
    gate.resolve();
    controller.abort();
    await pending;
  }
});

test("an incomplete chunked request cannot admit work and reception holds no physical lease", async (t) => {
  const f = await applicationFixture(t),
    target = path.join(f.home, "incomplete"),
    request = await attempt(f, target);
  const req = http.request(request.url, { method: "PUT", headers: request.headers });
  req.on("error", () => {});
  req.write(Buffer.from([0xf0, 0x9f]));
  await delay(25);
  const files = f.application.files;
  assert.equal(files.jobs.list(await files.context()).jobs.length, 0);
  assert.equal(files.store.listPublications().length, 0);
  assert.equal(f.application.mutationBarrier.active, 0);
  assert.equal(files.locks.active.size, 0);
  await f.application.mutationBarrier.snapshot(() =>
    assert.equal(files.store.listPublications().length, 0),
  );
  req.destroy();
  await delay(25);
  assert.equal(await fs.stat(target).catch(() => null), null);
  assert.equal(files.store.listPublications().length, 0);
});

test("a session becoming headless during accepted staging revokes publication authority", async (t) => {
  const f = await applicationFixture(t),
    session = {
      id: "changing-scope",
      name: "text fixture",
      tool: "shell",
      status: "exited",
      cwd: f.home,
    };
  await f.application.sessions.save(session);
  const base = "/api/sessions/changing-scope/files/explorer";
  const context = await (await f.request(`${base}/context`)).json();
  const files = f.application.files,
    run = files.publisher.native.run.bind(files.publisher.native);
  const gate = Promise.withResolvers(),
    entered = Promise.withResolvers();
  let publications = 0;
  files.publisher.native.run = async (op, args) => {
    if (op === "write") {
      entered.resolve();
      await gate.promise;
    }
    if (["exchange", "renameNoReplace"].includes(op)) publications++;
    return run(op, args);
  };
  const saving = fixtureFetch(`${f.url}${base}/text?path=queued`, {
    method: "PUT",
    headers: {
      origin: f.url,
      "content-type": "text/plain",
      "x-file-scope": context.scopeId,
      "x-file-request": uploadRequest(),
      "if-none-match": "*",
    },
    body: "accepted draft",
  });
  try {
    await entered.promise;
    await f.application.sessions.save({ ...session, pipeline: { headless: true } });
  } finally {
    gate.resolve();
  }
  const response = await saving;
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "FILE_INVALID_SCOPE");
  assert.equal(publications, 0);
  assert.equal(await fs.stat(path.join(f.home, "queued")).catch(() => null), null);
});
