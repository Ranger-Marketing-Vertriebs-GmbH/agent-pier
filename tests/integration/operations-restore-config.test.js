import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";

const hostIndependent = {
  pipelines: { portRangeStart: 31000, portRangeEnd: 31099, turnTimeoutMinutes: 90 },
  previews: { enabled: true, portRangeStart: 48100, portRangeEnd: 48109 },
  ticketRules: { intervalMinutes: 5 },
  files: { limits: { uploadBytes: 1048576 } },
};
const hostBound = {
  remoteUrl: "https://old-host.tail1234.ts.net:8443",
  ownerLogin: "owner@example.com",
  network: { enabled: true, bind: "0.0.0.0", hosts: ["old-host.local"] },
};

async function roundTrip(t, { backupHost, restoreHost, live = {}, saved }) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "restore-config-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"),
    liveDir = path.join(root, "live"),
    target = path.join(root, "target");
  await fs.mkdir(source);
  await fs.mkdir(liveDir);
  await fs.writeFile(path.join(source, "accounts.json"), "[]");
  await fs.writeFile(
    path.join(source, "config.json"),
    JSON.stringify(saved ?? { port: 4480, ...hostIndependent, ...hostBound, future: 1 }),
  );
  await fs.writeFile(path.join(liveDir, "config.json"), JSON.stringify(live));
  const backup = await new Backup({
    dataDir: source,
    home: root,
    hostId: backupHost,
  }).create();
  const report = await new Restore({ dataDir: liveDir, hostId: restoreHost }).apply({
    archive: backup.file,
    targetDataDir: target,
  });
  const config = JSON.parse(await fs.readFile(path.join(target, "config.json"), "utf8"));
  return { report, config };
}

test("a restore on the same host keeps every setting of config.json", async (t) => {
  const { report, config } = await roundTrip(t, {
    backupHost: "host-a",
    restoreHost: "host-a",
  });
  assert.deepEqual(config, { ...hostIndependent, ...hostBound });
  assert.deepEqual(report.settings, {
    sameHost: true,
    restored: [...Object.keys(hostIndependent), ...Object.keys(hostBound)],
    fromThisInstance: [],
    setAgain: [],
  });
});

test("a restore on another host reports the host-bound settings to set again", async (t) => {
  const { report, config } = await roundTrip(t, {
    backupHost: "host-a",
    restoreHost: "host-b",
  });
  assert.deepEqual(config, hostIndependent);
  assert.deepEqual(report.settings, {
    sameHost: false,
    restored: Object.keys(hostIndependent),
    fromThisInstance: [],
    setAgain: ["remoteUrl", "ownerLogin", "network"],
  });
});

test("a restore keeps the address of the instance that ran it reachable", async (t) => {
  const live = {
    port: 4380,
    remoteUrl: "https://new-host.tail1234.ts.net",
    ownerLogin: "owner@example.com",
  };
  for (const restoreHost of ["host-a", "host-b"]) {
    const { report, config } = await roundTrip(t, {
      backupHost: "host-a",
      restoreHost,
      live,
    });
    assert.equal(config.port, 4380);
    assert.equal(config.remoteUrl, live.remoteUrl);
    assert.equal(config.ownerLogin, live.ownerLogin);
    assert.deepEqual(report.settings.fromThisInstance, [
      "port",
      "remoteUrl",
      "ownerLogin",
    ]);
    assert.deepEqual(
      report.settings.setAgain,
      restoreHost === "host-a" ? [] : ["network"],
    );
    if (restoreHost === "host-a") assert.deepEqual(config.network, hostBound.network);
  }
});

test("a host that names no identifier never counts as the same host", async (t) => {
  const { report, config } = await roundTrip(t, { backupHost: null, restoreHost: null });
  assert.equal(report.settings.sameHost, false);
  assert.equal(config.remoteUrl, undefined);
});

test("unusable archived settings are dropped instead of breaking the start", async (t) => {
  const { config, report } = await roundTrip(t, {
    backupHost: "host-a",
    restoreHost: "host-a",
    saved: {
      files: { limits: { bogus: -1 } },
      network: { enabled: "yes" },
      remoteUrl: "not a url",
      pipelines: [1],
    },
  });
  assert.deepEqual(config, {});
  assert.deepEqual(report.settings.restored, []);
});

test("a backup from before config settings travelled restores an empty config", async (t) => {
  const { config, report } = await roundTrip(t, {
    backupHost: "host-a",
    restoreHost: "host-a",
    saved: {},
  });
  assert.deepEqual(config, {});
  assert.equal(report.settings.sameHost, true);
});
