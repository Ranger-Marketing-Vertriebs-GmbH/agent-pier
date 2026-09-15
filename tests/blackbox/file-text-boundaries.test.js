import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { applicationFixture, fixtureFetch } from "../helpers/application.js";
import { uploadRequest } from "../helpers/file-uploads.js";

async function headersFor(f, base = "/api/files") {
  const scope = await (await f.request(`${base}/context`)).json();
  return {
    cookie: f.cookie,
    origin: f.url,
    "content-type": "text/plain;charset=utf-8",
    "x-file-scope": scope.scopeId,
    "x-file-request": uploadRequest(),
    "if-none-match": "*",
  };
}
const urlFor = (f, target, base = "/api/files") =>
  `${f.url}${base}/text?${new URLSearchParams({ path: target })}`;
const raw = (url, headers, chunks) =>
  new Promise((resolve, reject) => {
    const req = http.request(url, { method: "PUT", headers }, (res) => {
      const bytes = [];
      res.on("data", (chunk) => bytes.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode, body: Buffer.concat(bytes).toString() }),
      );
    });
    req.on("error", reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });

test("strict raw headers reject missing, weak, non-d1, list, duplicate, and conflicting preconditions", async (t) => {
  const f = await applicationFixture(t),
    target = path.join(f.home, "headers");
  const defaults = await headersFor(f),
    d1 = `d1:${"a".repeat(64)}`;
  delete defaults["if-none-match"];
  for (const condition of [
    {},
    ...[
      "*",
      d1,
      `W/"${d1}"`,
      `"e1:${"a".repeat(64)}"`,
      `"p1:${"a".repeat(64)}"`,
      `"${d1}", "${d1}"`,
    ].map((value) => ({ "if-match": value })),
    { "if-none-match": `"${d1}"` },
    { "if-match": `"${d1}"`, "if-none-match": "*" },
  ]) {
    const response = await fixtureFetch(urlFor(f, target), {
      method: "PUT",
      headers: { ...defaults, ...condition },
      body: "private rejected draft",
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "FILE_TEXT_PRECONDITION");
  }
  const duplicate = await raw(
    urlFor(f, target),
    [...Object.entries(defaults).flat(), "if-match", `"${d1}"`, "if-match", `"${d1}"`],
    [Buffer.from("rejected")],
  );
  assert.equal(duplicate.status, 400);
  assert.equal(f.application.files.store.listPublications().length, 0);
  assert.equal(await fs.stat(target).catch(() => null), null);
});

test("actual chunked UTF8 counts BOM and multibyte boundaries; JSON retains its separate cap", async (t) => {
  const f = await applicationFixture(t),
    target = path.join(f.home, "limit");
  const bytes = Buffer.concat([
    Buffer.from("\uFEFF😀\r\n"),
    Buffer.alloc(2 * 1024 ** 2 - 9, 97),
  ]);
  const headers = await headersFor(f);
  const result = await raw(urlFor(f, target), headers, [
    bytes.subarray(0, 1),
    bytes.subarray(1, 5),
    bytes.subarray(5, 6),
    bytes.subarray(6),
  ]);
  assert.equal(result.status, 200, result.body);
  assert.deepEqual(await fs.readFile(target), bytes);
  assert.equal(
    (
      await (
        await f.request(`/api/files/text?${new URLSearchParams({ path: target })}`)
      ).json()
    ).bom,
    true,
  );
  const large = await raw(
    urlFor(f, target + "2"),
    { ...headers, "x-file-request": uploadRequest() },
    [bytes, Buffer.from("x")],
  );
  assert.equal(large.status, 413, large.body);
  assert.equal(await fs.stat(target + "2").catch(() => null), null);
  const json = await f.request("/api/files/operations", {
    method: "POST",
    headers: { "x-file-scope": headers["x-file-scope"] },
    body: { content: "x".repeat(70000) },
  });
  assert.equal(json.status, 413);
});

test("both metadata prefixes preserve entry view, enforce document scope, and allow headless reads only", async (t) => {
  const f = await applicationFixture(t),
    project = path.join(f.home, "project");
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, "target"), "original");
  await fs.symlink("target", path.join(project, "selected"));
  const session = {
    id: "text-session",
    name: "text fixture",
    tool: "shell",
    status: "exited",
    cwd: project,
  };
  await f.application.sessions.save(session);
  const base = "/api/sessions/text-session/files/explorer";
  for (const [prefix, selected, resolved] of [
    ["/api/files", path.join(project, "selected"), path.join(project, "target")],
    [base, "selected", "target"],
  ]) {
    const query = new URLSearchParams({ path: selected });
    const document = await (await f.request(`${prefix}/text?${query}`)).json();
    const metadata = await (
      await f.request(`${prefix}/metadata?${query}&view=document`)
    ).json();
    assert.deepEqual(metadata, {
      path: selected,
      resolvedPath: resolved,
      metadataRevision: document.metadataRevision,
    });
    const entry = await (await f.request(`${prefix}/metadata?${query}`)).json();
    assert.equal(entry.type, "symlink");
    assert.deepEqual(
      await (await f.request(`${prefix}/metadata?${query}&view=entry`)).json(),
      entry,
    );
    for (const view of [
      "view=unknown",
      "view=document&view=entry",
      "view[mode]=document",
      "view=",
    ])
      assert.equal((await f.request(`${prefix}/metadata?${query}&${view}`)).status, 400);
  }
  const headers = await headersFor(f, base);
  assert.equal(
    (
      await fixtureFetch(urlFor(f, "created", base), {
        method: "PUT",
        headers,
        body: "created",
      })
    ).status,
    200,
  );
  assert.equal(await fs.readFile(path.join(project, "created"), "utf8"), "created");
  await fs.symlink(f.home, path.join(project, "outside"));
  assert.equal(
    (await f.request(`${base}/metadata?path=outside&view=document`)).status,
    403,
  );
  await f.application.sessions.save({ ...session, pipeline: { headless: true } });
  assert.equal(
    (await (await f.request(`${base}/text?path=target`)).json()).readOnly,
    true,
  );
  assert.equal(
    (await f.request(`${base}/metadata?path=selected&view=document`)).status,
    200,
  );
  assert.equal(
    (
      await fixtureFetch(urlFor(f, "forbidden", base), {
        method: "PUT",
        headers,
        body: "draft",
      })
    ).status,
    409,
    "old scope became stale",
  );
  assert.equal(
    (
      await fixtureFetch(urlFor(f, "forbidden", base), {
        method: "PUT",
        headers: await headersFor(f, base),
        body: "draft",
      })
    ).status,
    403,
    "fresh headless scope remains read-only",
  );
  assert.equal(await fs.stat(path.join(project, "forbidden")).catch(() => null), null);
});

test("raw routes reject anonymous, machine, foreign-origin and stale scope authority before any stage", async (t) => {
  const f = await applicationFixture(t),
    target = path.join(f.home, "authority"),
    headers = await headersFor(f);
  for (const [extra, status] of [
    [{ cookie: "" }, 401],
    [{ authorization: "Bearer fixture-machine-token" }, 403],
    [{ origin: "https://foreign.example" }, 403],
    [{ "x-file-scope": "f1:stale" }, 409],
  ]) {
    const response = await fetch(urlFor(f, target), {
      method: "PUT",
      headers: { ...headers, ...extra },
      body: "draft",
    });
    assert.equal(response.status, status);
  }
  for (const type of [
    "application/json",
    "application/octet-stream",
    "text/plain;charset=utf-16",
    'text/plain;charset="utf-8',
  ]) {
    assert.equal(
      (
        await fixtureFetch(urlFor(f, target), {
          method: "PUT",
          headers: { ...headers, "content-type": type },
          body: "draft",
        })
      ).status,
      415,
    );
  }
  assert.equal(f.application.files.store.listPublications().length, 0);
});

test("an over-limit chunked sender receives 413 before ending its body", async (t) => {
  const f = await applicationFixture(t),
    target = path.join(f.home, "still-sending"),
    result = Promise.withResolvers();
  const req = http.request(
    urlFor(f, target),
    { method: "PUT", headers: await headersFor(f) },
    (res) => {
      res.resume();
      result.resolve(res.statusCode);
    },
  );
  req.on("error", (error) => result.resolve(error.code));
  const timer = setTimeout(() => result.resolve("fixture response deadline"), 3000);
  try {
    req.write(Buffer.alloc(2 * 1024 ** 2 + 1, 97));
    assert.equal(await result.promise, 413);
    assert.equal(f.application.files.store.listPublications().length, 0);
  } finally {
    clearTimeout(timer);
    req.destroy();
  }
});
