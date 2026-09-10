import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture, fixtureFetch as fetch } from "../helpers/application.js";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzN8AAAAASUVORK5CYII=",
  "base64",
);
async function fixture(t) {
  const { root: dir, home, application: app, url } = await applicationFixture(t);
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  const sessions = {
    one: { id: "one", accountId: "local-codex", tool: "codex", cwd, status: "stopped" },
    two: { id: "two", accountId: "local-codex", tool: "codex", cwd, status: "stopped" },
  };
  const snapshots = {
    one: {
      availability: "ready",
      providerSessionId: "native-one",
      messages: [],
      tasks: [],
    },
    two: {
      availability: "ready",
      providerSessionId: "native-two",
      messages: [],
      tasks: [],
    },
  };
  app.sessions.get = async (id) => {
    if (!sessions[id]) throw Object.assign(new Error("Missing session"), { status: 404 });
    return sessions[id];
  };
  app.chat.read = async (id) => {
    await app.sessions.get(id);
    return snapshots[id];
  };
  return { ...app, dir, home, cwd, url, snapshots };
}
async function listing(f, id = "one") {
  const response = await fetch(`${f.url}/api/sessions/${id}/chat`);
  assert.equal(response.status, 200);
  return response.json();
}
test("reported Markdown, plain and quoted local image paths become scoped attachments with visible source paths", async (t) => {
  const f = await fixture(t);
  const absolute = path.join(f.dir, "outside project.png");
  fs.writeFileSync(absolute, png);
  fs.writeFileSync(path.join(f.cwd, "relative.png"), png);
  f.snapshots.one.messages = [
    {
      id: "m1",
      role: "assistant",
      text: `Preview: ![Result](<${absolute}>)\n\nSaved as \`relative.png\`.\nAgain: relative.png`,
    },
    { id: "tool", role: "tool", text: `${absolute}\n` },
    { id: "user", role: "user", text: "relative.png" },
    {
      id: "remote",
      role: "assistant",
      text: "![External](https://example.invalid/private.png) data:image/png;base64,AAA",
    },
  ];
  const data = await listing(f);
  assert.equal(data.messages[0].images?.length, 2);
  assert.deepEqual(
    data.messages[0].images.map((i) => i.path),
    [absolute, "relative.png"],
  );
  assert.equal(data.messages[1].images.length, 0);
  assert.equal(data.messages[2].images.length, 1);
  assert.equal(data.messages[2].images[0].path, "relative.png");
  assert.deepEqual(data.messages[3].images, []);
  const item = data.messages[0].images[0];
  assert.match(item.id, /^[a-f0-9]{64}$/);
  assert.ok(!item.url.includes(encodeURIComponent(absolute)));
  const response = await fetch(f.url + item.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
});
test("image routes reject arbitrary paths, another session, stale transcript and foreign origins, and accept a user-authored reference", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.cwd, "image.png"), png);
  f.snapshots.one.messages = [{ id: "m", role: "assistant", text: "./image.png" }];
  const image = (await listing(f)).messages[0].images?.[0];
  assert.ok(image, "reported path has a server-scoped attachment");
  for (const headers of [
    { origin: "https://foreign.invalid" },
    { "sec-fetch-site": "cross-site" },
  ])
    assert.equal((await fetch(f.url + image.url, { headers })).status, 403);
  assert.equal((await fetch(f.url + image.url.replace("/one/", "/two/"))).status, 404);
  assert.equal(
    (
      await fetch(
        `${f.url}/api/sessions/one/chat/images/${"0".repeat(64)}?path=${encodeURIComponent(path.join(f.cwd, "image.png"))}`,
      )
    ).status,
    404,
  );
  f.snapshots.one.messages = [{ id: "u", role: "user", text: "./image.png" }];
  assert.equal((await fetch(f.url + image.url)).status, 200);
  f.snapshots.one.messages = [];
  assert.equal((await fetch(f.url + image.url)).status, 404);
});
test("missing, oversized, symlinked and disguised active/text files never stream as images", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.cwd, "secret.png"), "private-token-value");
  fs.writeFileSync(
    path.join(f.cwd, "active.png"),
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  );
  fs.writeFileSync(path.join(f.cwd, "okay.png"), png);
  fs.symlinkSync(path.join(f.cwd, "okay.png"), path.join(f.cwd, "link.png"));
  const handle = fs.openSync(path.join(f.cwd, "large.png"), "w");
  fs.writeSync(handle, png);
  fs.ftruncateSync(handle, 20 * 1024 * 1024 + 1);
  fs.closeSync(handle);
  f.snapshots.one.messages = [
    {
      id: "m",
      role: "assistant",
      text: "secret.png active.png missing.png large.png link.png",
    },
  ];
  const data = await listing(f);
  assert.equal(data.messages[0].images?.length, 5);
  for (const image of data.messages[0].images) {
    const response = await fetch(f.url + image.url);
    assert.ok(
      [404, 413, 415].includes(response.status),
      `${image.path}: ${response.status}`,
    );
    assert.equal((await response.text()).includes("private-token-value"), false);
  }
});
test("relative and file URI paths resolve against the session, duplicate references collapse and lists stay bounded", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.home, "home.png"), png);
  fs.writeFileSync(path.join(f.cwd, "image space.png"), png);
  f.snapshots.one.messages = [
    {
      id: "m",
      role: "assistant",
      text: `![a](file://${encodeURI(path.join(f.cwd, "image space.png"))})\n![b](<./image space.png>)\n~/home.png\n`,
    },
    {
      id: "many",
      role: "assistant",
      text: Array.from({ length: 20 }, (_, i) => `image-${i}.png`).join("\n"),
    },
  ];
  const data = await listing(f);
  assert.equal(data.messages[0].images?.length, 2);
  assert.equal(data.messages[1].images.length, 8);
  for (const image of data.messages[0].images)
    assert.equal((await fetch(f.url + image.url)).status, 200);
});

test("multiple inline absolute paths are recognized separately without treating the whole sentence as a filename", async (t) => {
  const f = await fixture(t);
  const a = path.join(f.cwd, "first.png"),
    b = path.join(f.cwd, "second.png");
  fs.writeFileSync(a, png);
  fs.writeFileSync(b, png);
  f.snapshots.one.messages = [{ id: "m", role: "assistant", text: `${a} ${b}` }];
  const images = (await listing(f)).messages[0].images;
  assert.deepEqual(
    images.map((image) => image.path),
    [a, b],
  );
  for (const image of images) assert.equal((await fetch(f.url + image.url)).status, 200);
});
test("MIME follows raster magic instead of extension and unsupported SVG paths never become image attachments", async (t) => {
  const f = await fixture(t);
  const samples = [
    [
      "jpeg",
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]),
      "image/jpeg",
    ],
    ["gif", Buffer.from("47494638396101000100800000", "hex"), "image/gif"],
    [
      "webp",
      Buffer.from("5249464614000000574542505650382004000000", "hex"),
      "image/webp",
    ],
    [
      "avif",
      Buffer.from("00000018667479706176696600000000617669666d696631", "hex"),
      "image/avif",
    ],
  ];
  f.snapshots.one.messages = [
    {
      id: "m",
      role: "assistant",
      text: samples.map(([name]) => `${name}.png`).join(" ") + "\nactive.svg",
    },
  ];
  for (const [name, buffer] of samples)
    fs.writeFileSync(path.join(f.cwd, `${name}.png`), buffer);
  const images = (await listing(f)).messages[0].images;
  assert.equal(images.length, 4);
  for (let i = 0; i < images.length; i++) {
    const response = await fetch(f.url + images[i].url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), samples[i][2]);
  }
});
test("an image path the user sent is rendered in their own message", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.cwd, "sent.png"), png);
  f.snapshots.one.messages = [
    { id: "m1", role: "user", text: `Schau dir das an\n${path.join(f.cwd, "sent.png")}` },
  ];
  const body = await listing(f);
  assert.equal(body.messages[0].images.length, 1);
  assert.equal(body.messages[0].images[0].path, path.join(f.cwd, "sent.png"));
});

test("tool paths never become previews or displace images addressed to the user", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.cwd, "result.png"), png);
  f.snapshots.one.messages = [
    { id: "answer", role: "assistant", text: "![Ergebnis](./result.png)" },
  ];
  const image = (await listing(f)).messages[0].images[0];
  f.snapshots.one.messages = [
    ...f.snapshots.one.messages,
    ...Array.from({ length: 70 }, (_, index) => ({
      id: `tool-${index}`,
      role: "tool",
      text: "${directory}/pending.png ...png pending.png ./result.png",
    })),
  ];
  const data = await listing(f);
  assert.equal(data.messages[0].images.length, 1);
  assert.ok(data.messages.slice(1).every((message) => message.images.length === 0));
  assert.equal((await fetch(f.url + image.url)).status, 200);
  f.snapshots.one.messages.shift();
  assert.equal((await fetch(f.url + image.url)).status, 404);
});

test("paged historical images remain scoped and expire on a history reset", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.cwd, "older.png"), png);
  f.snapshots.one.history = { generation: "generation-one" };
  f.chat.older = async () => ({
    ...f.snapshots.one,
    messages: [{ id: "older", role: "assistant", text: "./older.png" }],
  });
  const response = await fetch(`${f.url}/api/sessions/one/chat/history?cursor=opaque`);
  assert.equal(response.status, 200);
  const page = await response.json();
  const image = page.messages[0].images[0];
  assert.equal((await fetch(f.url + image.url)).status, 200);
  assert.equal((await fetch(f.url + image.url.replace("/one/", "/two/"))).status, 404);
  f.snapshots.one.history = { generation: "generation-two" };
  assert.equal((await fetch(f.url + image.url)).status, 404);
});
