import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSandboxProfiles,
  readSandboxProfiles,
} from "../../server/features/nono/nono-profiles.js";

// Captured verbatim from `nono profile list --silent` (nono 0.77.0). The
// `opencode` row is a real parse failure nono reports inline; it must not
// appear in the parsed sandbox profile list.
const REAL_NONO_OUTPUT =
  "nono profile: 23 profiles\n" +
  "\n" +
  "  Built-in:\n" +
  "    bun-dev          Bun runtime development profile            extends default\n" +
  "    default          Default conservative base profile          \n" +
  "    go-dev           Go SDK development profile with GOPATH and module support extends default\n" +
  "    java-dev         Java SDK development profile with SDKMAN, Maven, and Gradle support extends default\n" +
  "    linux-host-compat Linux compatibility profile for host runtime, sysfs, and temp access extends default\n" +
  "    mise-dev         Mise: dev tools, env vars, task runner     extends default\n" +
  "    node-dev         Node.js SDK development profile with nvm, fnm, pnpm, and npm support extends default\n" +
  "    python-dev       Python SDK development profile with pyenv, conda, and pip support extends default\n" +
  "    rust-dev         Rust SDK development profile with cargo and rustup support extends default\n" +
  "\n" +
  "  Packages:\n" +
  "    agy              Runtime-discovered path additions for agy  from nolabs-ai/antigravity\n" +
  "    antigravity      Runtime-discovered path additions for agy  from nolabs-ai/antigravity\n" +
  "    claude           Anthropic Claude Code CLI agent (registry-managed) from nolabs-ai/claude\n" +
  "    claude-code      Anthropic Claude Code CLI agent (registry-managed) from nolabs-ai/claude\n" +
  "\n" +
  "  User (/Users/chja/.config/nono/profiles):\n" +
  "    agy-default                                                 extends nolabs-ai/antigravity\n" +
  "    agy-kscan-isps   Profile for ISPS monorepo                  extends agy-default\n" +
  "    agy-kscan-library Profile for SIT Shared Library             extends agy-default\n" +
  "    cc-kscan-isps    Profile for ISPS monorepo                  extends claude-default\n" +
  "    cc-kscan-library Profile for SIT Shared Library             extends claude-default\n" +
  "    claude-default                                              extends nolabs-ai/claude\n" +
  "    opencode         [error: Profile parse error: unknown field `model`, expected one of " +
  "`$schema`, `extends`, `meta`, `security`, `groups`, `commands`, `filesystem`, `network`, " +
  "`diagnostics`, `linux`, `env_credentials`, `environment`, `command_policies`, " +
  "`credential_capture`, `credential_providers`, `credential_routes`, `workdir`, `hooks`, " +
  "`session_hooks`, `rollback`, `open_urls`, `allow_launch_services`, `allow_gpu`, " +
  "`allow_parent_of_protected`, `interactive`, `skipdirs`, `packs`, `binary`, `command_args`, " +
  "`unsafe_macos_seatbelt_rules`, `platform_overrides` on line 1 column 1]\n" +
  "    opencode-default                                            extends nolabs-ai/opencode\n" +
  "    opencode-kscan-isps Profile for ISPS monorepo                  extends opencode-default\n" +
  "    opencode-kscan-library Profile for SIT Shared Library             extends opencode-default\n";

test("parseSandboxProfiles reads real nono output, dropping the summary line, headings, and a failed sandbox profile", () => {
  assert.deepEqual(parseSandboxProfiles(REAL_NONO_OUTPUT), [
    "bun-dev",
    "default",
    "go-dev",
    "java-dev",
    "linux-host-compat",
    "mise-dev",
    "node-dev",
    "python-dev",
    "rust-dev",
    "agy",
    "antigravity",
    "claude",
    "claude-code",
    "agy-default",
    "agy-kscan-isps",
    "agy-kscan-library",
    "cc-kscan-isps",
    "cc-kscan-library",
    "claude-default",
    "opencode-default",
    "opencode-kscan-isps",
    "opencode-kscan-library",
  ]);
  const names = parseSandboxProfiles(REAL_NONO_OUTPUT);
  assert.ok(
    !names.includes("opencode"),
    "a sandbox profile nono failed to parse must be excluded",
  );
  assert.ok(names.includes("opencode-default"));
});

test("parseSandboxProfiles reads a heading-and-blank-line row and drops the heading and the blank line", () => {
  const output =
    "  Built-in:\n\n    bun-dev          Bun runtime development profile            extends default\n";
  assert.deepEqual(parseSandboxProfiles(output), ["bun-dev"]);
});

test("parseSandboxProfiles removes duplicates but keeps order", () => {
  const output =
    "    opencode-default                                            extends nolabs-ai/opencode\n" +
    "    claude-default                                              extends nolabs-ai/claude\n" +
    "    opencode-default                                            extends nolabs-ai/opencode\n";
  assert.deepEqual(parseSandboxProfiles(output), ["opencode-default", "claude-default"]);
});

test("readSandboxProfiles returns an empty list when nono fails", async () => {
  const profiles = await readSandboxProfiles({
    executable: "/nonexistent/nono",
    run: async () => {
      throw new Error("spawn failed");
    },
  });
  assert.deepEqual(profiles, []);
});

test("readSandboxProfiles passes the profile list arguments", async () => {
  const calls = [];
  const profiles = await readSandboxProfiles({
    executable: "/opt/homebrew/bin/nono",
    run: async (executable, args) => {
      calls.push([executable, args]);
      return "    claude-default                                              extends nolabs-ai/claude\n";
    },
  });
  assert.deepEqual(profiles, ["claude-default"]);
  assert.deepEqual(calls, [["/opt/homebrew/bin/nono", ["profile", "list", "--silent"]]]);
});
