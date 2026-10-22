import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "./process-guard.js";
import { GatewayClient } from "../../server/features/assistants/gateway-client.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { patchConfig } from "../../server/features/assistants/openclaw-config/live-patch.js";
import { assistantModelServer } from "./assistant-model-server.js";
import { createGatewaySession } from "../../server/features/assistants/session-create.js";

// Shared fixture for the shell contract: an isolated Gateway on the deterministic
// model, whose exec calls are set per turn through `gateway.tool`. `environment`
// reshapes the Gateway's process environment before the spawn. The exec shell
// wrapper RuntimeSupervisor writes points to a simulated owner account in the test
// directory (`gateway.owner`), never to the developer's own HOME.
export async function shellGateway(t, installed, { prefix, environment, setup } = {}) {
  assert.ok(path.isAbsolute(installed));
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const tool = { name: "exec", arguments: { command: "true" } };
  const model = await assistantModelServer({ tool });
  const owner = ownerAccount(dataDir);
  const runtime = new RuntimeSupervisor({
    dataDir,
    shellOwner: () => ({ home: owner.home, pathPrepend: [] }),
    install: async () => ({
      version: runtimeManifest.version,
      nodePath: path.join(installed, "node/bin/node"),
      entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
    }),
    spawn: (command, args, options) =>
      spawnProcess(command, args, {
        ...options,
        env: environment ? environment(options.env, runtime.paths) : options.env,
      }),
  });
  await setup?.(runtime, dataDir, owner);
  const approvers = [];
  t.after(async () => {
    try {
      for (const approver of approvers) approver.close();
      await runtime.close();
      await model.close();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  await runtime.start();
  const gateway = {
    runtime,
    dataDir,
    owner,
    model,
    tool,
    get client() {
      return runtime.client;
    },
    // Test-only: the fixture model plus `patch`; bypasses prepareRuntimeConfig.
    configure: (patch, replacePaths) =>
      patchConfig(runtime.client, () => ({
        patch: {
          models: {
            providers: {
              fixture: {
                baseUrl: model.url,
                api: "openai-completions",
                apiKey: "fixture-key",
                models: [
                  {
                    id: "fixture-model",
                    name: "Fixture",
                    contextWindow: 32768,
                    maxTokens: 4096,
                  },
                ],
              },
            },
          },
          ...patch,
          agents: {
            ...patch.agents,
            defaults: {
              ...patch.agents?.defaults,
              model: { primary: "fixture/fixture-model" },
            },
          },
        },
        ...(replacePaths && { replacePaths }),
      })),
    // Creates a Gateway agent on the fixture model, as AssistantConfig does.
    async agent(name) {
      const created = await runtime.client.call("agents.create", {
        name,
        workspace: path.join(runtime.paths.workspaces, name),
        model: "fixture/fixture-model",
      });
      for (let n = 0; n < 50; n++) {
        const roster = await runtime.client.call("agents.list", {}).catch(() => ({}));
        if (roster.agents?.some((a) => a.id === created.agentId)) return created.agentId;
        await delay(100);
      }
      throw Error(`agent ${name} did not appear`);
    },
    // Starts one turn in which the model calls `exec` with `args` once.
    async send(label, args, agentId = "main") {
      tool.arguments = typeof args === "string" ? { command: args } : args;
      const from = model.requests.length;
      const session = await createGatewaySession(runtime.client, { agentId, label });
      const sent = await runtime.client.call("sessions.send", {
        key: session.key,
        message: "Run the command.",
        idempotencyKey: label,
      });
      return { session, runId: sent.runId, from };
    },
    async settle(run) {
      const done = await runtime.client.call(
        "agent.wait",
        { runId: run.runId, timeoutMs: 60000 },
        { timeoutMs: 65000 },
      );
      assert.equal(done.status, "ok");
      const requests = model.requests.slice(run.from);
      return {
        offered: requests[0]?.tools?.map((d) => d.function.name) ?? [],
        result: requests
          .flatMap((r) => r.messages || [])
          .filter((m) => m.role === "tool")
          .map((m) => String(m.content))
          .at(-1),
      };
    },
    async turn(label, args, agentId) {
      return gateway.settle(await gateway.send(label, args, agentId));
    },
    // A second client that declares the "exec-approvals" cap and records events.
    async approver() {
      const approver = new GatewayClient({
        url: runtime.client.url,
        token: runtime.client.token,
        certPath: runtime.client.certPath,
        caps: ["exec-approvals"],
      });
      approvers.push(approver);
      await approver.connect();
      approver.events = [];
      approver.subscribe((frame) => approver.events.push(frame));
      return approver;
    },
  };
  return gateway;
}

export async function eventually(find, { tries = 300, ms = 200 } = {}) {
  for (let i = 0; i < tries; i++) {
    const found = find();
    if (found) return found;
    await delay(ms);
  }
  return undefined;
}

// The next approval request for `run`, or undefined when none arrives in `ms` total.
export function requestFor(approver, run, total = 60000) {
  return eventually(
    () =>
      approver.events.find(
        (e) =>
          e.event === "exec.approval.requested" && e.payload.request.runId === run.runId,
      )?.payload,
    { tries: Math.ceil(total / 200) },
  );
}

// Answers the request for `run` with `decision` when one arrives within `ms`, then
// waits for the turn. Returns the request (or undefined) and the turn's tool result.
export async function decide(gateway, approver, run, decision, ms = 60000) {
  const request = await requestFor(approver, run, ms);
  if (request) await approver.call("exec.approval.resolve", { id: request.id, decision });
  return { request, ...(await gateway.settle(run)) };
}

// A run that must not ask: it completes, and no request names it.
export async function silent(gateway, approver, run) {
  const outcome = await gateway.settle(run);
  assert.equal(
    approver.events.some(
      (e) =>
        e.event === "exec.approval.requested" && e.payload.request.runId === run.runId,
    ),
    false,
    `${run.runId} ran without asking`,
  );
  return outcome;
}

// A simulated owner account inside the test directory, never the developer's HOME:
// a marker, a fake gh login, a login profile that puts `bin` on PATH, and a fake
// `gh` that reports which hosts file it read.
export function ownerAccount(root) {
  const home = path.join(root, "owner-home");
  const bin = path.join(root, "owner-bin");
  fs.mkdirSync(path.join(home, ".config/gh"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(home, "owner-marker"), "owner\n");
  fs.writeFileSync(
    path.join(home, ".config/gh/hosts.yml"),
    "github.com:\n  user: fixture\n",
  );
  for (const name of [".profile", ".zprofile", ".bash_profile"])
    fs.writeFileSync(path.join(home, name), `export PATH="${bin}:$PATH"\n`);
  fs.writeFileSync(
    path.join(bin, "gh"),
    '#!/bin/sh\nprintf "fake-gh %s\\n" "$(sed -n 2p "$HOME/.config/gh/hosts.yml")"\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "homeprobe"),
    '#!/bin/sh\nprintf "%s\\n" "$HOME" > "$1"\n',
    {
      mode: 0o755,
    },
  );
  return { home, bin };
}

export const listTree = (dir) =>
  fs.readdirSync(dir, { recursive: true }).map(String).sort();

export async function answer(promise) {
  try {
    return { result: await promise };
  } catch (error) {
    return {
      code: error.code,
      message: error.message,
      answered: error.answered === true,
    };
  }
}
