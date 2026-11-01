import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureTailscale } from "../../scripts/tailscale.mjs";
import { updateStoredConfig } from "../../server/lib/config.js";

const status = {
  BackendState: "Running",
  Self: { UserID: 7, DNSName: "box.tail.ts.net." },
  User: { 7: { LoginName: "owner@example.com" } },
};

function fakeTailscale(calls) {
  return (args) => {
    calls.push(args);
    if (args.join(" ") === "status --json") return JSON.stringify(status);
    if (args.join(" ") === "serve status --json") return "{}";
    return "Available within your tailnet";
  };
}

function withDataDir(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-tailscale-"));
  try {
    return fn(dataDir);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const read = (dataDir) =>
  JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));

test("Tailscale setup keeps every other saved setting", () =>
  withDataDir((dataDir) => {
    const saved = {
      port: 4390,
      remoteUrl: "https://old.tail.ts.net:8443",
      ownerLogin: "old@example.com",
      network: { enabled: true, bind: "0.0.0.0", hosts: ["a.example"] },
      pipelines: { portRange: { start: 41000, end: 41999 } },
      files: { limits: { uploadBytes: 1024 } },
    };
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(saved));
    const calls = [];
    const url = configureTailscale({
      config: { dataDir, port: 4390 },
      run: fakeTailscale(calls),
      log: () => {},
    });
    assert.equal(url, "https://box.tail.ts.net:8443");
    assert.deepEqual(read(dataDir), {
      ...saved,
      remoteUrl: "https://box.tail.ts.net:8443",
      ownerLogin: "owner@example.com",
    });
    assert.equal(fs.statSync(path.join(dataDir, "config.json")).mode & 0o777, 0o600);
    assert.deepEqual(calls.at(-1), [
      "serve",
      "--bg",
      "--https=8443",
      "http://127.0.0.1:4390",
    ]);
  }));

test("Tailscale setup creates the config file when none exists", () =>
  withDataDir((dataDir) => {
    configureTailscale({
      config: { dataDir, port: 4380 },
      run: fakeTailscale([]),
      log: () => {},
    });
    assert.deepEqual(read(dataDir), {
      port: 4380,
      remoteUrl: "https://box.tail.ts.net:8443",
      ownerLogin: "owner@example.com",
    });
  }));

test("updateStoredConfig merges a patch into config.json privately", () =>
  withDataDir((dataDir) => {
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ port: 4390, files: { limits: {} } }),
    );
    const next = updateStoredConfig(dataDir, { remoteUrl: "https://x" });
    assert.deepEqual(next, { port: 4390, files: { limits: {} }, remoteUrl: "https://x" });
    assert.deepEqual(read(dataDir), next);
    assert.equal(fs.statSync(path.join(dataDir, "config.json")).mode & 0o777, 0o600);
  }));
