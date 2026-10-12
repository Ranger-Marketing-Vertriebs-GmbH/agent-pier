import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { compileOpenClawConfig } from "../../server/features/assistants/runtime-config.js";

// A Gateway double with OpenClaw's merge-patch rules: null deletes a key, and a
// patch that drops array items needs the array's exact path in replacePaths.
// `answers[method]` overrides a method: a value, an error, or a function of the
// params. `calls` records every call.
export function mergeGateway(effective) {
  const patches = [];
  const answers = {};
  const calls = [];
  const merge = (base, patch, at, replace) => {
    const result = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      const where = at ? `${at}.${key}` : key;
      const dropped = (before, after) =>
        Array.isArray(before) &&
        (!Array.isArray(after) || before.some((item) => !after.includes(item)));
      if (dropped(base?.[key], value) && !replace.includes(where))
        throw Object.assign(Error(`would remove entries from ${where}`), {
          answered: true,
          code: "INVALID_REQUEST",
        });
      const nested = (v) => v && typeof v === "object" && !Array.isArray(v);
      if (nested(base?.[key]) && value === null) {
        for (const [k, v] of Object.entries(base[key]))
          if (Array.isArray(v) && !replace.includes(`${where}.${k}`))
            throw Object.assign(Error(`would remove entries from ${where}.${k}`), {
              answered: true,
              code: "INVALID_REQUEST",
            });
      }
      if (value === null) delete result[key];
      else if (nested(value)) result[key] = merge(base?.[key], value, where, replace);
      else result[key] = value;
    }
    return result;
  };
  const files = {};
  const listeners = new Set();
  return {
    ready: true,
    patches,
    answers,
    calls,
    // Announces each committed write as OpenClaw does, after the patch answered.
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    effective: () => effective,
    async call(method, params) {
      calls.push({ method, params });
      if (method in answers) {
        const answer = answers[method];
        if (answer instanceof Error) throw answer;
        return typeof answer === "function" ? answer(params) : answer;
      }
      if (method === "config.get")
        return { hash: String(patches.length), config: structuredClone(effective) };
      if (method === "config.patch") {
        const patch = JSON.parse(params.raw);
        patches.push({ patch, replacePaths: params.replacePaths });
        effective = merge(effective, patch, "", params.replacePaths || []);
        const hash = String(patches.length);
        setImmediate(() => {
          for (const listener of [...listeners])
            listener({ event: "config.changed", payload: { hash } });
        });
        return {};
      }
      if (method === "agents.list")
        return { agents: Object.keys(effective.agents.entries).map((id) => ({ id })) };
      if (method === "agents.update") return {};
      if (method === "agents.files.get")
        return {
          file:
            params.name in files ? { content: files[params.name] } : { missing: true },
        };
      if (method === "agents.files.set") {
        files[params.name] = params.content;
        return {};
      }
      assert.fail(method);
    },
  };
}

export const ownerPath = ["/owner/bin"];
const model = { connectionId: "c", modelId: "m" };

/**
 * An AssistantService over a real store and AssistantConfig, whose Gateway is a
 * mergeGateway started with the compiled configuration of `names` (team plugin and
 * native interfaces ready). `audit` records the service's audit entries.
 */
export function shellService(t, names = ["Home", "Other"]) {
  const dataDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "shell-service-")),
  );
  const store = new AssistantStore({ dataDir });
  const agents = names.map((name) =>
    store.createAssistant({ name, instructions: "", model }),
  );
  const started = compileOpenClawConfig({
    paths: { workspaces: path.join(dataDir, "w"), logs: path.join(dataDir, "l") },
    port: 1234,
    token: "t",
    teams: {
      directory: "/plugin",
      connection: { url: "http://127.0.0.1:1", token: "bridge" },
      hostMaxConcurrent: 4,
      native: { token: "hook" },
      profiles: agents,
    },
    shell: { pathPrepend: ownerPath },
  });
  started.agents.entries = Object.fromEntries(
    agents.map((a) => [a.runtimeAgentId, { id: a.runtimeAgentId, model: "c/m" }]),
  );
  const client = mergeGateway(started);
  const models = {
    resolve: async () => ({ modelRef: "c/m", release() {} }),
    listCapabilities: () => [],
  };
  const config = new AssistantConfig({
    client,
    store,
    models,
    workspaces: dataDir,
    teamReady: () => true,
  });
  Object.assign(config, {
    nativeReady: () => true,
    writeGuard: () => false,
    webToolsAvailable: () => ({}),
    shellPathPrepend: () => ownerPath,
    mcpTools: () => [],
  });
  const runtime = Object.assign(new EventEmitter(), {
    client,
    status: () => ({ availability: "ready" }),
    close: async () => {},
  });
  const audit = [];
  const warnings = [];
  const service = new AssistantService({
    store,
    models,
    runtime,
    config,
    audit: { append: (entry) => audit.push(entry) },
  });
  service.shellChanges.warn = (line) => warnings.push(line);
  t.after(async () => {
    await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const live = (agent) => client.effective().agents.entries[agent.runtimeAgentId];
  return {
    dataDir,
    store,
    client,
    config,
    runtime,
    service,
    audit,
    warnings,
    agents,
    live,
  };
}
