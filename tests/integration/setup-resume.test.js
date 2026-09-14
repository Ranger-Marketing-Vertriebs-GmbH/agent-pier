import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setupFixture } from "../helpers/setup-fixture.js";
import { Releases } from "../../server/features/operations/releases.js";
import { switchRelease } from "../../server/features/operations/release-activation.js";

test("setup resumes the actual app version without staging or restarting", async (t) => {
  const f = await setupFixture(t);
  await f.install();
  await new Releases({
    dataDir: f.dataDir,
    installRoot: f.installRoot,
    smoke: async () => {},
  }).stage({ archive: await f.archive("2.0.0") });
  switchRelease(f.installRoot, "2.0.0");
  f.stageCalls.length = 0;
  f.restartCalls.length = 0;
  const result = await f.install();
  assert.equal(result.version, "2.0.0");
  assert.equal(await fs.readlink(path.join(f.installRoot, "current")), "releases/2.0.0");
  assert.equal(f.stageCalls.length, 0);
  assert.equal(f.restartCalls.length, 0);
});
for (const phase of ["prepared", "staged", "selected", "service", "healthy"]) {
  test(`resume after durable ${phase} retains the original target`, async (t) => {
    const f = await setupFixture(t);
    await assert.rejects(
      f.install(
        {},
        {
          afterPhase: async (value) => {
            if (value === phase) throw Error("interrupted");
          },
        },
      ),
      /interrupted/,
    );
    const result = await f.install({ archive: await f.archive("2.0.0") });
    assert.equal(result.version, "1.0.0");
    assert.equal(
      await fs.readlink(path.join(f.installRoot, "current")),
      "releases/1.0.0",
    );
  });
}
test("unknown roots and foreign service/listener cause no mutation", async (t) => {
  for (const kind of ["root", "service", "listener"]) {
    const f = await setupFixture(t);
    if (kind === "root") {
      await fs.mkdir(f.installRoot);
      await fs.writeFile(path.join(f.installRoot, "foreign"), "keep");
    }
    if (kind === "service") f.state.service = "conflict";
    if (kind === "listener") f.state.listener = true;
    await assert.rejects(f.install(), /conflict/i);
    await assert.rejects(fs.stat(path.join(f.installRoot, ".setup.json")), {
      code: "ENOENT",
    });
    assert.equal(f.restartCalls.length, 0);
  }
});
test("no-service preserves active version and leaves service alone", async (t) => {
  const f = await setupFixture(t);
  const result = await f.install({ service: false });
  assert.equal(result.serviceInstalled, false);
  assert.equal(f.restartCalls.length, 0);
  await f.install({ service: false });
  assert.equal(f.restartCalls.length, 0);
});

test("stopped matching service is repaired without staging and retains channel", async (t) => {
  const f = await setupFixture(t);
  await f.install({
    channel: "https://updates.example/releases/",
    initialChannel: "https://updates.example/v1/",
  });
  f.state.listener = false;
  f.stageCalls.length = 0;
  f.restartCalls.length = 0;
  const result = await f.install({
    channel: "https://other.example/",
    initialChannel: "https://other.example/v2/",
  });
  assert.equal(result.version, "1.0.0");
  assert.equal(f.stageCalls.length, 0);
  assert.equal(
    f.restartCalls[0].env.AGENTPIER_RELEASE_CHANNEL,
    "https://updates.example/releases/",
  );
});
for (const kind of [
  "corrupt",
  "schema",
  "paths",
  "dangling",
  "legacy",
  "target",
  "cache-link",
  "target-url",
]) {
  test(`rejects ${kind} setup state before dependencies or service changes`, async (t) => {
    const f = await setupFixture(t);
    await f.install();
    const file = path.join(f.installRoot, ".setup.json");
    const receipt = JSON.parse(await fs.readFile(file, "utf8"));
    if (kind === "corrupt") await fs.writeFile(file, "bad json");
    if (kind === "schema")
      await fs.writeFile(file, JSON.stringify({ ...receipt, schema: 99 }));
    if (kind === "paths")
      await fs.writeFile(
        file,
        JSON.stringify({ ...receipt, dataDir: `${f.dataDir}-other` }),
      );
    if (kind === "target")
      await fs.writeFile(file, JSON.stringify({ ...receipt, target: {} }));
    if (kind === "target-url")
      await fs.writeFile(
        file,
        JSON.stringify({
          ...receipt,
          target: { ...receipt.target, url: "https://unrelated.test/release.aprelease" },
        }),
      );
    if (kind === "legacy") await fs.unlink(file);
    if (kind === "dangling")
      await fs.rm(path.join(f.installRoot, "releases/1.0.0"), { recursive: true });
    if (kind === "cache-link") {
      await fs.unlink(path.join(f.installRoot, ".setup-target.aprelease"));
      await fs.symlink(
        f.options.archive,
        path.join(f.installRoot, ".setup-target.aprelease"),
      );
    }
    const before = await fs.readFile(file).catch(() => null);
    await assert.rejects(
      f.install(
        {},
        {
          run: async () => {
            assert.fail("dependency mutation");
          },
        },
      ),
      /conflict/i,
    );
    assert.deepEqual(await fs.readFile(file).catch(() => null), before);
  });
}
for (const live of [true, false]) {
  test(`setup ${live ? "rejects live" : "recovers dead"} owned lock`, async (t) => {
    const f = await setupFixture(t);
    await f.install();
    await fs.writeFile(
      path.join(f.installRoot, ".setup.lock"),
      JSON.stringify({
        pid: live ? process.pid : 2147483647,
        installRoot: f.installRoot,
        dataDir: f.dataDir,
      }),
      { mode: 0o600 },
    );
    if (live) await assert.rejects(f.install(), /live setup lock/);
    else assert.equal((await f.install()).version, "1.0.0");
  });
}
test("simultaneous setup cannot claim or replace an owned target", async (t) => {
  const f = await setupFixture(t);
  let entered, proceed;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const paused = new Promise((resolve) => {
    proceed = resolve;
  });
  const first = f.install(
    {},
    {
      afterPhase: async (phase) => {
        if (phase === "prepared") {
          entered();
          await paused;
        }
      },
    },
  );
  await waiting;
  try {
    await assert.rejects(f.install({ archive: await f.archive("2.0.0") }), /setup lock/);
  } finally {
    proceed();
  }
  assert.equal((await first).version, "1.0.0");
});
test("existing installation still checks and repairs missing dependencies", async (t) => {
  const f = await setupFixture(t);
  await f.install();
  let available = false;
  const run = async (command, args) => {
    if (command === "tmux" && !available) throw Error("missing");
    if (args.includes("install")) available = true;
    return { stdout: "fixture" };
  };
  await assert.rejects(
    f.install({ installDependencies: false }, { run }),
    /--install-dependencies/,
  );
  assert.equal(available, false);
  const result = await f.install({}, { run });
  assert.deepEqual(result.installedDependencies, ["tmux"]);
});
test("ordinary low-level installation keeps existing-install rejection", async (t) => {
  const f = await setupFixture(t);
  await f.install();
  await assert.rejects(f.install({ resume: false }), /already exists/);
});
test("remote retry uses recorded artifact when latest advances", async (t) => {
  const f = await setupFixture(t);
  const { digest } = await import("../../server/features/operations/files.js");
  const bytes = await fs.readFile(f.options.archive);
  let latest = "1.0.0",
    manifestCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("latest.json")) {
      manifestCalls++;
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          version: latest,
          artifacts: {
            [`${process.platform}-${process.arch}`]: {
              file: `${latest}.aprelease`,
              sha256: digest(bytes),
            },
          },
        }),
      );
    }
    assert.equal(url, "https://example.test/initial/1.0.0.aprelease");
    return new Response(bytes);
  };
  const releaseOptions = { ...f.dependencies.releaseOptions, fetchImpl };
  await assert.rejects(
    f.install(
      { archive: undefined, initialChannel: "https://example.test/initial/" },
      {
        releaseOptions,
        afterPhase: async (phase) => {
          if (phase === "prepared") throw Error("interrupted");
        },
      },
    ),
    /interrupted/,
  );
  latest = "2.0.0";
  const result = await f.install({ archive: undefined }, { releaseOptions });
  assert.equal(result.version, "1.0.0");
  assert.equal(manifestCalls, 1);
});

test("selected files are revalidated and staged files reused after interruption", async (t) => {
  const f = await setupFixture(t);
  await assert.rejects(
    f.install(
      {},
      {
        afterPhase: async (phase) => {
          if (phase === "staged") throw Error("interrupted");
        },
      },
    ),
    /interrupted/,
  );
  const count = f.stageCalls.length;
  await f.install();
  assert.equal(f.stageCalls.length, count);
  await fs.unlink(path.join(f.installRoot, "current/bin/node"));
  await assert.rejects(f.install(), /conflict/);
});
test("health failure retains selection for service retry", async (t) => {
  const f = await setupFixture(t);
  f.state.healthy = false;
  await assert.rejects(f.install(), /health.*service logs/);
  f.state.healthy = true;
  f.stageCalls.length = 0;
  assert.equal((await f.install()).version, "1.0.0");
  assert.equal(f.stageCalls.length, 0);
});

for (const scenario of [
  "missing",
  "stopped",
  "healthy",
  "foreign-file",
  "foreign-job",
  "foreign-pid",
  "prefix-data",
]) {
  test(`macOS service inspection identifies ${scenario} without host commands`, async (t) => {
    const f = await setupFixture(t);
    const { renderLaunchAgent } = await import("../../scripts/service.mjs");
    const { inspectSetupService } = await import("../../scripts/setup-service.mjs");
    const directory = path.join(f.temporary, "Library/LaunchAgents");
    await fs.mkdir(directory, { recursive: true });
    const vars = {
      AGENTPIER_INSTALL_ROOT: f.installRoot,
      AGENTPIER_DATA_DIR: scenario === "foreign-file" ? "/foreign" : f.dataDir,
      AGENTPIER_RELEASE_CHANNEL: "https://ongoing.test/",
    };
    const launcher = path.join(f.installRoot, "bin/agentpier");
    if (scenario !== "missing")
      await fs.writeFile(
        path.join(directory, "dev.agentpier.server.plist"),
        renderLaunchAgent({
          projectDir: path.join(f.installRoot, "current"),
          launcher,
          installRoot: f.installRoot,
          dataDir: vars.AGENTPIER_DATA_DIR,
          envPath: "/usr/bin",
        }),
      );
    const run = async (command) => {
      if (command === "plutil")
        return {
          stdout: JSON.stringify({
            Label: "dev.agentpier.server",
            ProgramArguments: [launcher],
            EnvironmentVariables: vars,
          }),
        };
      if (command === "launchctl") {
        if (["missing", "stopped"].includes(scenario))
          throw Object.assign(Error("not loaded"), { code: 113 });
        return {
          stdout: `program = ${scenario === "foreign-job" ? "/other" : launcher}\nAGENTPIER_INSTALL_ROOT => ${f.installRoot}\nAGENTPIER_DATA_DIR => ${f.dataDir}${scenario === "prefix-data" ? "-other" : ""}\npid = 123\n`,
        };
      }
      if (command === "lsof") {
        if (["missing", "stopped"].includes(scenario))
          throw Object.assign(Error("no listener"), { code: 1 });
        return { stdout: scenario === "foreign-pid" ? "456\n" : "123\n" };
      }
      assert.fail(`Unexpected external command ${command}`);
    };
    const result = await inspectSetupService({
      installRoot: f.installRoot,
      dataDir: f.dataDir,
      home: f.temporary,
      platform: "darwin",
      run,
    });
    assert.equal(
      result.state,
      scenario === "missing"
        ? "missing"
        : ["stopped", "healthy"].includes(scenario)
          ? "matching"
          : "conflict",
    );
    if (scenario === "healthy") {
      assert.equal(result.listener, true);
      assert.equal(result.channel, "https://ongoing.test/");
    }
  });
}

test("service finalization waits for startup before checking listener ownership", async (t) => {
  const f = await setupFixture(t);
  const result = await f.install(
    {},
    {
      serviceRunner: async () => {
        f.state.service = "matching";
        f.state.listener = false;
      },
      health: async () => {
        f.state.listener = true;
        return true;
      },
    },
  );
  assert.equal(result.url, "http://127.0.0.1:4380");
});

test("fresh setup refuses existing data without an ownership receipt", async (t) => {
  const f = await setupFixture(t);
  await fs.mkdir(f.dataDir);
  await fs.writeFile(path.join(f.dataDir, "old-profile"), "preserve");
  await assert.rejects(f.install(), /conflict/);
  await assert.rejects(fs.stat(f.installRoot), { code: "ENOENT" });
  assert.equal(
    await fs.readFile(path.join(f.dataDir, "old-profile"), "utf8"),
    "preserve",
  );
});
test("setup refuses a concurrent lock recovery guard", async (t) => {
  const f = await setupFixture(t);
  await f.install();
  await fs.writeFile(path.join(f.installRoot, ".setup-recovery.lock"), "recovering", {
    mode: 0o600,
  });
  await assert.rejects(f.install(), /conflict|recovery/);
  assert.equal(
    await fs.readFile(path.join(f.installRoot, ".setup-recovery.lock"), "utf8"),
    "recovering",
  );
});

test("separate processes recover a dead lock with one exclusive owner", async (t) => {
  const f = await setupFixture(t);
  await f.install();
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  await fs.writeFile(
    path.join(f.installRoot, ".setup.lock"),
    JSON.stringify({ pid: 2147483647, installRoot: f.installRoot, dataDir: f.dataDir }),
    { mode: 0o600 },
  );
  const moduleUrl = new URL("../../scripts/setup-state.mjs", import.meta.url).href;
  const script = `import { acquireSetupLock, inspectSetup } from ${JSON.stringify(moduleUrl)};
    const options = JSON.parse(process.argv[1]);
    process.stdin.once("data", () => {
      try {
        const release = acquireSetupLock(options.installRoot, inspectSetup(options));
        console.log("owned");
        process.stdin.once("data", () => { release(); process.exit(0); });
      } catch { console.log("rejected"); process.exit(0); }
    });
    console.log("ready");`;
  const children = Array.from({ length: 4 }, () =>
    spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        script,
        JSON.stringify({ installRoot: f.installRoot, dataDir: f.dataDir }),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    ),
  );
  t.after(() => children.forEach((child) => child.kill()));
  await Promise.all(children.map((child) => once(child.stdout, "data")));
  const outcomes = children.map((child) =>
    once(child.stdout, "data").then(([data]) => data.toString().trim()),
  );
  children.forEach((child) => child.stdin.write("start\n"));
  const values = await Promise.all(outcomes);
  assert.equal(values.filter((value) => value === "owned").length, 1);
  const owner = children[values.indexOf("owned")];
  const lock = JSON.parse(
    await fs.readFile(path.join(f.installRoot, ".setup.lock"), "utf8"),
  );
  assert.equal(lock.pid, owner.pid);
  const ended = once(owner, "exit");
  owner.stdin.write("release\n");
  await ended;
});

test("setup remains compatible after an in-app data schema update", async (t) => {
  const f = await setupFixture(t);
  await f.install();
  await new Releases({
    dataDir: f.dataDir,
    installRoot: f.installRoot,
    smoke: async () => {},
  }).stage({ archive: await f.archive("2.0.0") });
  const manifestPath = path.join(f.installRoot, "releases/2.0.0/release.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, schemaMax: 2 }));
  switchRelease(f.installRoot, "2.0.0");
  await fs.mkdir(path.join(f.dataDir, "memory"));
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(f.dataDir, "memory/memory.sqlite"));
  db.exec("PRAGMA user_version = 2");
  db.close();
  assert.equal((await f.install()).version, "2.0.0");
});

test("fresh setup preserves an explicitly configured ongoing environment channel", async (t) => {
  const f = await setupFixture(t);
  await f.install(
    {},
    {
      env: {
        PATH: process.env.PATH,
        AGENTPIER_RELEASE_CHANNEL: "https://environment.test/releases/",
      },
    },
  );
  assert.equal(
    f.restartCalls[0].env.AGENTPIER_RELEASE_CHANNEL,
    "https://environment.test/releases/",
  );
});
