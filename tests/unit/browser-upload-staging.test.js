import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  BrowserUploads,
  openclawUploadDir,
  stagedName,
  trusted,
  uploadLimits,
} from "../../server/features/assistants/browser-upload-staging.js";

function fixture(t, { limits = uploadLimits, now = () => 1000 } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "browser-upload-staging-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, "project");
  fs.mkdirSync(path.join(project, "episodes"), { recursive: true });
  fs.mkdirSync(path.join(project, ".git"));
  fs.writeFileSync(path.join(project, "episodes", "episode 1.mp4"), "video-bytes");
  fs.writeFileSync(path.join(project, ".git", "config"), "secret");
  fs.writeFileSync(path.join(base, "outside.txt"), "outside");
  // OpenClaw's private temp root; AgentPier creates uploads/ below it.
  fs.mkdirSync(path.join(base, "openclaw"), { mode: 0o700 });
  const uploadDir = path.join(base, "openclaw", "uploads");
  const dataRoot = path.join(base, "data", "assistants");
  fs.mkdirSync(dataRoot, { recursive: true });
  const uploads = new BrowserUploads({ tmp: base, dataRoot, uploadDir, now, limits });
  return { base, project, uploadDir, dataRoot, uploads };
}
const source = (root, raw, extra = {}) => ({ root, raw, ...extra });

test("a project file is copied below the agent's own folder of the namespace", async (t) => {
  const { project, uploadDir, uploads } = fixture(t);
  const entry = await uploads.stage(
    "agent-1",
    source(project, "episodes/episode 1.mp4"),
    {
      projectId: "p1",
      site: "studio.youtube.com",
    },
  );
  assert.equal(entry.name, "episode 1.mp4");
  assert.equal(entry.relative, "episodes/episode 1.mp4");
  assert.equal(entry.bytes, 11);
  assert.equal(entry.projectId, "p1");
  assert.ok(entry.path.startsWith(path.join(uploads.namespace(), "agent-1") + path.sep));
  assert.ok(entry.path.startsWith(uploadDir + path.sep));
  assert.equal(fs.readFileSync(entry.path, "utf8"), "video-bytes");
  assert.equal(fs.statSync(entry.path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(entry.path)).mode & 0o777, 0o700);
  // A copy: the project file keeps its single link and stays readable for projects.
  assert.equal(fs.statSync(path.join(project, "episodes", "episode 1.mp4")).nlink, 1);
  // Absolute inside the folder works the same.
  const again = await uploads.stage(
    "agent-1",
    source(project, path.join(project, "episodes", "episode 1.mp4")),
  );
  assert.notEqual(again.path, entry.path);
});

test("the project read rules refuse links, .git, hard links, folders and escapes", async (t) => {
  const { base, project, uploads } = fixture(t);
  fs.symlinkSync(path.join(base, "outside.txt"), path.join(project, "leak.txt"));
  fs.symlinkSync(base, path.join(project, "up"));
  fs.linkSync(path.join(base, "outside.txt"), path.join(project, "hard.txt"));
  const refused = async (raw, key, extra) =>
    assert.rejects(uploads.stage("agent-1", source(project, raw, extra)), { key });
  await refused("leak.txt", "projectPathRefused");
  await refused("up/outside.txt", "projectPathRefused");
  await refused("../outside.txt", "projectPathRefused");
  await refused(path.join(base, "outside.txt"), "projectPathRefused");
  await refused(".git/config", "projectPathRefused");
  await refused(".GIT/config", "projectPathRefused");
  await refused("hard.txt", "projectFileUnsuitable");
  await refused("episodes", "projectFileUnsuitable");
  await refused("missing.mp4", "notFound");
  // AgentPier's own data inside a project folder stays closed.
  fs.mkdirSync(path.join(project, "data"));
  fs.writeFileSync(path.join(project, "data", "db"), "x");
  await refused("data/db", "projectPathRefused", {
    protectedRoots: [path.join(project, "data")],
  });
  // A guarded workspace entry (prompt files, attachments) is never staged.
  fs.mkdirSync(path.join(project, "attachments"));
  fs.writeFileSync(path.join(project, "attachments", "a.png"), "x");
  await refused("attachments/a.png", "projectPathRefused", {
    admit: (relative) => {
      if (relative.startsWith("attachments/"))
        throw Object.assign(Error("refused"), { key: "projectPathRefused" });
    },
  });
  if (process.platform !== "win32") {
    execFileSync("mkfifo", [path.join(project, "pipe")]);
    await refused("pipe", "projectFileUnsuitable");
  }
  assert.equal(uploads.entries.size, 0);
});

test("a file over the size limit or without free space is refused", async (t) => {
  const { project, uploads } = fixture(t, {
    limits: { ...uploadLimits, maxBytes: 5 },
  });
  await assert.rejects(
    uploads.stage("agent-1", source(project, "episodes/episode 1.mp4")),
    {
      key: "browserUploadTooLarge",
    },
  );
  const full = fixture(t, {
    limits: { ...uploadLimits, reserveBytes: Number.MAX_SAFE_INTEGER },
  });
  await assert.rejects(
    full.uploads.stage("agent-1", source(full.project, "episodes/episode 1.mp4")),
    { key: "browserUploadSpace" },
  );
  assert.deepEqual(fs.readdirSync(path.join(full.uploads.namespace(), "agent-1")), []);
});

test("the browser may upload only the calling agent's own staged files", async (t) => {
  const { base, project, uploadDir, uploads } = fixture(t);
  const own = await uploads.stage("agent-1", source(project, "episodes/episode 1.mp4"));
  const other = await uploads.stage("agent-2", source(project, "episodes/episode 1.mp4"));
  assert.deepEqual(uploads.admit("agent-1", [own.path]).used, [own]);
  // Spelled relative to the uploads folder, with OpenClaw's MEDIA: prefix, or through
  // its real path, it is the same file.
  assert.deepEqual(uploads.admit("agent-1", [path.relative(uploadDir, own.path)]).used, [
    own,
  ]);
  assert.deepEqual(uploads.admit("agent-1", [`MEDIA: ${own.path}`]).used, [own]);
  assert.deepEqual(uploads.admit("agent-1", [fs.realpathSync(own.path)]).used, [own]);
  const notStaged = { reason: "uploadNotStaged" };
  assert.deepEqual(uploads.admit("agent-1", [other.path]), notStaged);
  assert.deepEqual(uploads.admit("agent-1", [own.path, other.path]), notStaged);
  // A link to another agent's file in the uploads folder is that file.
  fs.symlinkSync(other.path, path.join(uploadDir, "alias.mp4"));
  assert.deepEqual(uploads.admit("agent-1", ["alias.mp4"]), notStaged);
  // Anything else in a namespace of AgentPier, also another data directory's.
  const foreign = path.join(uploadDir, "agentpier-0000000000000000", "x", "y", "f.mp4");
  fs.mkdirSync(path.dirname(foreign), { recursive: true });
  fs.writeFileSync(foreign, "x");
  assert.deepEqual(uploads.admit("agent-1", [foreign]), notStaged);
  if (process.platform === "darwin")
    assert.deepEqual(
      uploads.admit("agent-1", [foreign.replace("agentpier-", "AgentPier-")]),
      notStaged,
    );
  // A project file named directly is outside every folder the browser takes.
  assert.deepEqual(
    uploads.admit("agent-1", [path.join(project, "episodes", "episode 1.mp4")]),
    { reason: "uploadOutside" },
  );
  assert.deepEqual(uploads.admit("agent-1", [path.join(base, "outside.txt")]), {
    reason: "uploadOutside",
  });
  // OpenClaw's shared folders are no way around staging: any other file in its
  // uploads folder, inbound media and media:// references are refused too.
  const outside = { reason: "uploadOutside" };
  fs.writeFileSync(path.join(uploadDir, "own.pdf"), "x");
  assert.deepEqual(uploads.admit("agent-1", ["own.pdf"]), outside);
  assert.deepEqual(uploads.admit("agent-1", ["media://inbound/a.png"]), outside);
  assert.deepEqual(uploads.admit("agent-1", ["media/inbound/a.png"]), outside);
  assert.deepEqual(
    uploads.admit("agent-1", [path.join(base, "state", "media", "inbound", "a.png")]),
    outside,
  );
  assert.deepEqual(uploads.admit("agent-1", [own.path, "media://inbound/a"]), outside);
  assert.deepEqual(uploads.admit("agent-1", []), notStaged);
  assert.deepEqual(uploads.admit("agent-1", "x"), notStaged);
  assert.deepEqual(uploads.admit("agent-1", [own.path, 7]), notStaged);
});

test("staged files expire, stay bounded per agent and go with their agent", async (t) => {
  let now = 1000;
  const { project, uploads } = fixture(t, {
    now: () => now,
    limits: { ...uploadLimits, perAgent: 2, ttlMs: 100 },
  });
  const stage = (id) => uploads.stage(id, source(project, "episodes/episode 1.mp4"));
  const first = await stage("agent-1");
  now += 1;
  const second = await stage("agent-1");
  now += 1;
  const third = await stage("agent-1");
  // The oldest made room for the third.
  assert.equal(fs.existsSync(first.path), false);
  assert.deepEqual(uploads.admit("agent-1", [first.path]), { reason: "uploadNotStaged" });
  assert.ok(fs.existsSync(second.path) && fs.existsSync(third.path));
  const member = await stage("member-1");
  uploads.release("member-1");
  assert.equal(fs.existsSync(member.path), false);
  const kept = await stage("agent-2");
  uploads.sweep((id) => id !== "agent-2");
  assert.equal(fs.existsSync(kept.path), false);
  now += 100;
  uploads.sweep();
  assert.equal(fs.existsSync(third.path), false);
  assert.equal(uploads.entries.size, 0);
});

test("a new process removes what an earlier one left, and so does a clean stop", async (t) => {
  const { project, uploadDir, dataRoot, base, uploads } = fixture(t);
  const old = await uploads.stage("agent-1", source(project, "episodes/episode 1.mp4"));
  const next = new BrowserUploads({ tmp: base, dataRoot, uploadDir });
  // Unknown to the new process: refused, and removed when it starts.
  assert.deepEqual(next.admit("agent-1", [old.path]), { reason: "uploadNotStaged" });
  next.clear();
  assert.equal(fs.existsSync(old.path), false);
  assert.equal(fs.existsSync(next.namespace()), false);
  const fresh = await next.stage("agent-1", source(project, "episodes/episode 1.mp4"));
  next.clear();
  assert.equal(fs.existsSync(fresh.path), false);
  assert.equal(next.entries.size, 0);
  assert.equal(next.namespace(), uploads.namespace());
  // Below a folder others may write nothing is deleted or created.
  const again = await uploads.stage("agent-1", source(project, "episodes/episode 1.mp4"));
  fs.chmodSync(uploadDir, 0o777);
  uploads.entries.clear();
  uploads.clear();
  assert.equal(fs.existsSync(again.path), true);
  await assert.rejects(
    uploads.stage("agent-1", source(project, "episodes/episode 1.mp4")),
    { key: "unavailable" },
  );
});

test("staging is one copy at a time within the per-agent and total caps", async (t) => {
  const { project, uploads } = fixture(t, {
    limits: { ...uploadLimits, perAgent: 1, totalBytes: 30 },
  });
  const stage = (id) => uploads.stage(id, source(project, "episodes/episode 1.mp4"));
  // Parallel calls of one agent never hold more than its cap.
  const results = await Promise.all([
    stage("agent-1"),
    stage("agent-1"),
    stage("agent-1"),
  ]);
  assert.equal(uploads.entries.size, 1);
  assert.equal(fs.existsSync(results[2].path), true);
  assert.equal(
    results.slice(0, 2).some((e) => fs.existsSync(e.path)),
    false,
  );
  // 11 bytes each: a third agent's copy would pass the total of 30.
  await stage("agent-2");
  await assert.rejects(stage("agent-3"), { key: "browserUploadSpace" });
  assert.equal(uploads.entries.size, 2);
});

test("a copy that outlives its time is cancelled and leaves nothing", async (t) => {
  const { project, uploads } = fixture(t, { limits: { ...uploadLimits, copyMs: 1 } });
  fs.writeFileSync(path.join(project, "big.bin"), Buffer.alloc(64 * 1024 * 1024));
  await assert.rejects(uploads.stage("agent-1", source(project, "big.bin")), {
    key: "browserUploadSlow",
  });
  assert.equal(uploads.entries.size, 0);
  const own = path.join(uploads.namespace(), "agent-1");
  assert.deepEqual(fs.existsSync(own) ? fs.readdirSync(own) : [], []);
});

test("the uploads folder is OpenClaw's: /tmp/openclaw when trusted, else below TMPDIR", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "browser-upload-dir-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const preferred = path.join(base, "openclaw");
  assert.equal(openclawUploadDir(base, preferred), path.join(preferred, "uploads"));
  assert.ok(fs.statSync(preferred).isDirectory());
  const link = path.join(base, "linked");
  fs.symlinkSync(preferred, link);
  const uid = process.getuid?.();
  const fallback = path.join(
    base,
    "tmp",
    uid === undefined ? "openclaw" : `openclaw-${uid}`,
    "uploads",
  );
  assert.equal(openclawUploadDir(path.join(base, "tmp"), link), fallback);
  // A folder its group or others may write is not OpenClaw's either (fs-safe).
  fs.chmodSync(preferred, 0o770);
  assert.equal(trusted(preferred), false);
  assert.equal(openclawUploadDir(path.join(base, "tmp"), preferred), fallback);
  // Only named, never created.
  const missing = path.join(base, "missing");
  openclawUploadDir(base, missing, { create: false });
  assert.equal(fs.existsSync(missing), false);
});

test("the staged name is the file's own name, made safe", () => {
  assert.equal(stagedName("episodes/Episode 1.mp4"), "Episode 1.mp4");
  assert.equal(stagedName("a/b\u0001c.mp4"), "b_c.mp4");
  assert.equal(stagedName(""), "upload");
  assert.equal(stagedName(".."), "upload");
  assert.ok(Buffer.byteLength(stagedName(`${"ä".repeat(300)}.mp4`)) <= 200);
});

test("within one clock tick the newest staged file stays", async (t) => {
  const { project, uploads } = fixture(t, { limits: { ...uploadLimits, perAgent: 1 } });
  const stage = () => uploads.stage("agent-1", source(project, "episodes/episode 1.mp4"));
  const first = await stage();
  const second = await stage();
  assert.equal(fs.existsSync(first.path), false);
  assert.equal(fs.existsSync(second.path), true);
});
