import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { loadArchive } from "../helpers/backup-archive.js";
import { readArchiveHeader } from "../../server/features/operations/archive-v2.js";

// Android devices are not part of backups (docs/devices.md, docs/backups.md): the SDK
// is a download and a device is gigabytes of emulator state. No kind of backup takes
// a file from <data>/devices.
const passphrase = "devices backup fixture phrase";
for (const [label, options] of [
  ["without history", { includeHistory: false }],
  ["with history", { includeHistory: true }],
  ["with credentials", { includeHistory: true, withCredentials: true, passphrase }],
])
  test(`a backup ${label} holds nothing of the Android devices`, async (t) => {
    const f = await applicationFixture(t);
    const devices = path.join(f.dataDir, "devices");
    for (const [name, content] of [
      ["settings.json", '{"maxDevices":5,"maxRunning":2}'],
      ["devices.json", '{"version":1,"devices":[]}'],
      ["sdk/emulator/agentpier-receipt.json", "{}"],
      ["avd/d-0000000000a1.avd/config.ini", "avd.ini.encoding=UTF-8\n"],
      ["home/.android/adbkey", "adb-key-marker-7f3a91"],
      ["logs/d-0000000000a1.log", "log\n"],
    ]) {
      fs.mkdirSync(path.dirname(path.join(devices, name)), { recursive: true });
      fs.writeFileSync(path.join(devices, name), content);
    }
    const backup = await f.application.operations.backup.create(options);
    const header = await readArchiveHeader(backup.file);
    const names = [
      ...header.members.map((member) => member.path),
      ...loadArchive(backup.file).files.map((entry) => entry.path),
    ];
    assert.ok(names.length > 0);
    assert.deepEqual(
      names.filter((name) => /(^|\/)devices(\/|$)/.test(name)),
      [],
    );
    // Nothing of them is inside a member either (the adb key above all).
    assert.equal(fs.readFileSync(backup.file).includes("adb-key-marker-7f3a91"), false);
  });
