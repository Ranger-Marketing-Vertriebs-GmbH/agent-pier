import test from "node:test";
import assert from "node:assert/strict";
import {
  confineRemote,
  insideRoot,
  remotePath,
} from "../../server/features/sftp/sftp-remote-paths.js";

const refused = { code: "SFTP_PATH_REFUSED", status: 403 };

test("relative joins the root", () => {
  assert.equal(remotePath("site/index.html", "/www"), "/www/site/index.html");
  assert.equal(remotePath("./a/./b/../c", "/www"), "/www/a/c");
  assert.equal(remotePath("/etc/hosts", "/www"), "/etc/hosts");
  assert.equal(remotePath("", "/www"), "/www");
  assert.equal(remotePath("a//b/", "/"), "/a/b");
  assert.equal(remotePath("Datei mit Ümlaut", "/"), "/Datei mit Ümlaut");
  assert.equal(remotePath("-rf", "/"), "/-rf");
});

test(".. above / refused", () => {
  assert.throws(() => remotePath("../etc", "/"), refused);
  assert.throws(() => remotePath("a/../../b", "/"), refused);
  assert.throws(() => remotePath("/..", "/www"), refused);
  assert.equal(remotePath("../x", "/www"), "/x");
});

test("newline refused", () => {
  for (const raw of ["a\nb", "a\0b", "a\rb", "a\u007fb", "a\u2028b", "a\\b"])
    assert.throws(() => remotePath(raw, "/"), refused);
  assert.throws(() => remotePath("a".repeat(4097), "/"), refused);
  assert.throws(() => remotePath(42, "/"), refused);
  assert.throws(() => remotePath("a", "relative"), refused);
});

test("insideRoot compares whole segments", () => {
  assert.equal(insideRoot("/www", "/www"), true);
  assert.equal(insideRoot("/www", "/www/a"), true);
  assert.equal(insideRoot("/www", "/www2"), false);
  assert.equal(insideRoot("/", "/anything"), true);
  assert.equal(insideRoot("/www/", "/www/a"), true);
});

function fakeSession(real) {
  const calls = [];
  return {
    calls,
    async realpath(p) {
      calls.push(p);
      if (Object.hasOwn(real, p)) return real[p];
      throw Object.assign(new Error("SFTP_NOT_FOUND"), { code: "SFTP_NOT_FOUND" });
    },
  };
}

test("confineRemote refuses a symlink leaving the root", async () => {
  const session = fakeSession({
    "/": "/",
    "/www": "/www",
    "/www/a": "/www/a",
    "/www/link": "/etc",
  });
  await assert.rejects(confineRemote(session, "/www/link", "/www"), refused);
  await assert.rejects(confineRemote(session, "/www/link/new/file", "/www"), refused);
  await assert.rejects(confineRemote(session, "/etc/passwd", "/www"), refused);
  assert.equal(
    await confineRemote(session, "/www/a/new/file", "/www"),
    "/www/a/new/file",
  );
  assert.equal(await confineRemote(session, "/www", "/www"), "/www");
});

test("confineRemote resolves a root that is itself a link", async () => {
  const session = fakeSession({ "/www": "/srv/www", "/srv/www/a": "/srv/www/a" });
  assert.equal(await confineRemote(session, "/www/a", "/www"), "/srv/www/a");
});

test("confineRemote without a root returns the path untouched", async () => {
  const session = fakeSession({});
  assert.equal(await confineRemote(session, "/etc/x", null), "/etc/x");
  assert.deepEqual(session.calls, []);
});

test("confineRemote passes other errors through", async () => {
  const session = {
    async realpath() {
      throw Object.assign(new Error("SFTP_PERMISSION"), { code: "SFTP_PERMISSION" });
    },
  };
  await assert.rejects(confineRemote(session, "/www/a", "/www"), {
    code: "SFTP_PERMISSION",
  });
});
