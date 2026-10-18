import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";
import { issue } from "../helpers/session-mcp.js";
import { zipEntries } from "../helpers/file-archives.js";

const png = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);

async function publisher(t) {
  const f = await applicationFixture(t);
  const issued = await issue(f, { choices: true });
  const project = f.application.memory.projects().projects[0];
  const publish = (input) =>
    f.application.artifacts.publish(
      { sessionId: issued.session.id, projectId: project.id, cwd: f.project },
      { requestId: randomUUID(), ...input },
      async () => {},
    );
  return { f, publish };
}

test("downloading an image artifact returns its original bytes and type to the owner", async (t) => {
  const { f, publish } = await publisher(t);
  await fs.writeFile(path.join(f.project, "chart.png"), png);
  const artifact = await publish({ title: "Latency: p99/p50", sourcePath: "chart.png" });
  const route = `/api/artifacts/${artifact.id}/download`;
  assert.equal((await fetch(f.url + route)).status, 401);
  const response = await f.request(route);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy"), /sandbox/);
  assert.equal(
    response.headers.get("content-disposition"),
    `attachment; filename="Latency_ p99_p50.png"; filename*=UTF-8''Latency_%20p99_p50.png`,
  );
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.equal((await f.request(`/api/artifacts/${randomUUID()}/download`)).status, 404);
  assert.equal((await f.request("/api/artifacts/..%2Fx/download")).status, 404);
});

test("a single page downloads as its original file and a folder as a zip of its tree", async (t) => {
  const { f, publish } = await publisher(t);
  await fs.writeFile(path.join(f.project, "report.html"), "<h1>Report</h1>");
  const page = await publish({ title: "Bericht für März", sourcePath: "report.html" });
  const single = await f.request(`/api/artifacts/${page.id}/download`);
  assert.equal(single.status, 200);
  assert.equal(single.headers.get("content-type"), "application/octet-stream");
  assert.match(
    single.headers.get("content-disposition"),
    /filename\*=UTF-8''Bericht%20f%C3%BCr%20M%C3%A4rz\.html$/,
  );
  assert.equal(await single.text(), "<h1>Report</h1>");

  const site = path.join(f.project, "site");
  await fs.mkdir(path.join(site, "assets"), { recursive: true });
  await fs.writeFile(path.join(site, "index.html"), "<link href=assets/app.css>");
  await fs.writeFile(path.join(site, "assets", "app.css"), "body{}");
  await fs.writeFile(path.join(site, "assets", "logo.png"), png);
  const folder = await publish({
    title: "Site.zip",
    sourcePath: "site",
    entrypoint: "index.html",
  });
  const zipped = await f.request(`/api/artifacts/${folder.id}/download`);
  assert.equal(zipped.status, 200);
  assert.equal(zipped.headers.get("content-type"), "application/zip");
  assert.match(zipped.headers.get("content-disposition"), /filename="Site\.zip"/);
  const entries = await zipEntries(Buffer.from(await zipped.arrayBuffer()));
  assert.deepEqual([...entries.keys()].sort(), [
    "assets/app.css",
    "assets/logo.png",
    "index.html",
  ]);
  assert.equal(entries.get("index.html").toString(), "<link href=assets/app.css>");
  assert.deepEqual(entries.get("assets/logo.png"), png);
});

test("downloads share one owner budget per minute", async (t) => {
  const { f, publish } = await publisher(t);
  await fs.writeFile(path.join(f.project, "report.html"), "<h1>Report</h1>");
  const artifact = await publish({ title: "Report", sourcePath: "report.html" });
  const route = `/api/artifacts/${artifact.id}/download`;
  for (let index = 0; index < 30; index++)
    assert.equal((await f.request(route)).status, 200, String(index));
  const limited = await f.request(route);
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).code, "ARTIFACT_DOWNLOAD_RATE_LIMITED");
  // Viewing is not part of the download budget.
  assert.equal((await f.request(`/api/artifacts/${artifact.id}/bundle`)).status, 200);
});
