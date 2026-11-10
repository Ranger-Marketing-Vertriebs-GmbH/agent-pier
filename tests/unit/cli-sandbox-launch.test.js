import test from "node:test";
import assert from "node:assert/strict";
import { cliDriver } from "../../server/features/clis/drivers.js";
import {
  SYSTEM_CA_BUNDLE,
  sandboxLaunch as codexSandboxLaunch,
} from "../../server/features/clis/codex/sandbox.js";
import { NonoSandbox } from "../../server/features/nono/nono-launch.js";

const mac = { platform: "darwin", exists: () => true };
const flagValues = (args, flag) =>
  args.flatMap((value, index) => (args[index - 1] === flag ? [value] : []));

test("a sandboxed Codex on macOS reads its CA roots from the system bundle file", () => {
  const launch = { command: "/bin/codex", args: [], env: { PATH: "/bin" } };
  const prepared = codexSandboxLaunch(launch, mac);
  assert.equal(prepared.env.SSL_CERT_FILE, SYSTEM_CA_BUNDLE);
  assert.equal(SYSTEM_CA_BUNDLE, "/etc/ssl/cert.pem");
  assert.deepEqual(prepared.sandboxGrants, [{ access: "read", path: SYSTEM_CA_BUNDLE }]);
  // The launch handed in is not changed.
  assert.equal(launch.env.SSL_CERT_FILE, undefined);
});

test("the operator's own CA settings stay as they are", () => {
  for (const name of ["SSL_CERT_FILE", "CODEX_CA_CERTIFICATE"]) {
    const launch = { command: "/bin/codex", env: { [name]: "/corp/ca.pem" } };
    assert.equal(codexSandboxLaunch(launch, mac), launch, name);
  }
});

test("Codex keeps its launch where the bundle is missing or the host is not macOS", () => {
  const launch = { command: "/bin/codex", env: {} };
  assert.equal(codexSandboxLaunch(launch, { ...mac, exists: () => false }), launch);
  assert.equal(codexSandboxLaunch(launch, { ...mac, platform: "linux" }), launch);
});

test("the nono adapter hands a sandboxed Codex launch the CA file", async () => {
  const seen = [];
  const sandbox = new NonoSandbox({
    detect: () => [{ id: "nono", installed: true, path: "/bin/nono" }],
    readProfiles: async () => ["dev"],
    prepareCli: (tool, launch) => {
      seen.push(tool);
      return cliDriver(tool).sandboxLaunch(launch, mac);
    },
  });
  const launch = { command: "/bin/codex", args: [], env: { PATH: "/bin" } };
  const wrapped = await sandbox.prepare({ launch, profile: "dev", tool: "codex" });
  assert.deepEqual(seen, ["codex"]);
  assert.equal(wrapped.env.SSL_CERT_FILE, SYSTEM_CA_BUNDLE);
  assert.ok(flagValues(wrapped.args, "--read-file").includes(SYSTEM_CA_BUNDLE));
  const plain = await sandbox.prepare({ launch, profile: null, tool: "codex" });
  assert.equal(plain.env.SSL_CERT_FILE, undefined);
});
