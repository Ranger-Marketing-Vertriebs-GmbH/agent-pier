import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  personalCapabilities,
  personalShell,
  profileTools,
  sessionTools,
} from "./native-capabilities.js";
import { assistantProblem } from "./assistant-validation.js";
import { assertWired } from "./service-wiring.js";
import { assistantBootstrap } from "./assistant-bootstrap.js";
import { agentEntry } from "./openclaw-config/agent-entry.js";
import { patchConfig } from "./openclaw-config/live-patch.js";
import { watchConfigAdoption } from "./openclaw-config/config-adoption.js";
import { agentExec, shellSections, shellTools } from "./openclaw-config/shell.js";
// Bootstrap files the Gateway exposes besides AGENTS.md. AgentPier never creates
// them (skipBootstrap), so any content is foreign and is neutralized. USER.md is
// the owner's preference note and stays under owner control.
const foreignBootstrap = ["SOUL.md", "IDENTITY.md", "BOOTSTRAP.md"];
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The global tools.allow with exec and process present exactly when `wanted`, or
 * null when it already is (or the shell state is not managed: `wanted` undefined).
 */
function shellAllow(allow = [], wanted) {
  if (wanted === undefined) return null;
  const has = shellTools.every((tool) => allow.includes(tool));
  const none = !shellTools.some((tool) => allow.includes(tool));
  if (wanted ? has : none) return null;
  return [
    ...allow.filter((tool) => !shellTools.includes(tool)),
    ...(wanted ? shellTools : []),
  ];
}

export class AssistantConfig {
  constructor({
    client,
    models,
    store,
    workspaces,
    teamReady,
    hostCapacity,
    adoption = {},
  }) {
    Object.assign(this, {
      client,
      models,
      store,
      workspaces,
      teamReady,
      hostCapacity,
      adoption,
    });
    this.queue = Promise.resolve();
    this.applied = new Map();
  }
  reset() {
    this.applied.clear();
  }
  // Runs before every turn admission, including when the configuration is unchanged,
  // so instructions planted between turns never reach the next prompt.
  // `bootstrap` is the managed AGENTS.md content (owner instructions + guidance).
  async verifyBootstrap(assistant, bootstrap) {
    for (const name of ["AGENTS.md", ...foreignBootstrap]) {
      const expected = name === "AGENTS.md" ? bootstrap : "";
      const read = async () =>
        (
          await this.client.call("agents.files.get", {
            agentId: assistant.runtimeAgentId,
            name,
          })
        ).file;
      const intact = (file) =>
        file?.missing === true
          ? name !== "AGENTS.md" || expected === ""
          : file?.hash
            ? file.hash === sha256(expected)
            : file?.content === expected;
      const file = await read();
      if (intact(file)) continue;
      await this.client.call("agents.files.set", {
        agentId: assistant.runtimeAgentId,
        name,
        content: expected,
        ...(file?.missing
          ? { expectedMissing: true }
          : file?.hash
            ? { expectedHash: file.hash }
            : {}),
      });
      if (!intact(await read())) throw assistantProblem("conflict", 409);
    }
  }
  apply(id) {
    const task = this.queue.catch(() => {}).then(() => this.applyOnce(id));
    this.queue = task;
    return task;
  }
  async applyOnce(id) {
    assertWired(this);
    const assistant = this.store.getAssistant(id),
      lease = await this.models.resolve(assistant.model);
    const nativeReady = !!this.nativeReady?.();
    const capabilities = personalCapabilities(assistant);
    // The same availability the Gateway start compiled (webToolsAvailability).
    const available = this.webToolsAvailable?.() || {};
    // The agent's MCP globs the running Gateway was started with (mcpSections).
    const mcpTools = this.mcpTools?.(assistant) || [];
    // An agent whose own bot for other people the Gateway runs has no session tools.
    const senderFacing = !!this.senderFacing?.(assistant);
    const allowed = profileTools(
      assistant,
      this.teamReady?.(),
      nativeReady,
      !!this.writeGuard?.(),
      available,
      mcpTools,
    ).filter((tool) => !senderFacing || !sessionTools.includes(tool));
    // The owner's login PATH the running Gateway was started with (exec-shell.js).
    const pathPrepend = this.shellPathPrepend?.() || [];
    // As agentEntry compiles it; the readback below checks the same value.
    const exec = nativeReady
      ? agentExec(personalShell(assistant), pathPrepend)
      : undefined;
    // Global tools.allow is an upper bound for every agent; it carries exec and
    // process while some eligible agent has shell. It applies hot (fact c).
    const shellGlobal = nativeReady
      ? shellSections({ profiles: this.store.listAssistants?.() || [assistant] })
          .globalTools.length > 0
      : undefined;
    const bootstrap = assistantBootstrap(assistant, lease.display);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          assistant.revision,
          lease.modelRef,
          lease.provider,
          lease.agentRuntime,
          allowed,
          this.hostCapacity?.(),
          nativeReady,
          capabilities,
          exec,
          shellGlobal,
          bootstrap,
          senderFacing,
        ]),
      )
      .digest("hex");
    let adoption = null;
    try {
      if (
        this.applied.get(id) === fingerprint &&
        assistant.effectiveRevision === assistant.revision
      ) {
        await this.verifyBootstrap(assistant, bootstrap);
        this.onApplied?.(id);
        return {
          revision: assistant.revision,
          effectiveRevision: assistant.revision,
          status: "applied",
        };
      }
      // Watched before the first write, so the commit cannot be announced unseen.
      adoption = watchConfigAdoption(this.client, this.adoption);
      const base = adoption.watching ? await this.client.call("config.get", {}) : {};
      if (lease.provider)
        await patchConfig(this.client, () => ({
          patch: { models: { providers: { [lease.providerId]: lease.provider } } },
        }));
      const agents = await this.client.call("agents.list", {});
      if (!agents.agents?.some((a) => a.id === assistant.runtimeAgentId)) {
        const created = await this.client.call("agents.create", {
          name: assistant.runtimeAgentId,
          workspace: path.join(this.workspaces, assistant.id),
          model: lease.modelRef,
        });
        if (created.agentId !== assistant.runtimeAgentId)
          throw assistantProblem("conflict", 409);
      }
      // Profile creation commits before the Gateway's runtime roster reloads. While
      // its plugins reload, the Gateway answers the read-only roster call with
      // UNAVAILABLE; a lost connection (nothing answered) still fails at once.
      let visible = false;
      for (let n = 0; n < 50; n++) {
        const roster = await this.client.call("agents.list", {}).catch((error) => {
          if (error.code === "UNAVAILABLE" && error.answered) return {};
          throw error;
        });
        if (roster.agents?.some((a) => a.id === assistant.runtimeAgentId)) {
          visible = true;
          break;
        }
        await delay(100);
      }
      if (!visible) throw assistantProblem("unavailable", 503);
      // Events count from the last write on; agents.update always writes.
      adoption.mark();
      await this.client.call("agents.update", {
        agentId: assistant.runtimeAgentId,
        name: assistant.name,
        model: lease.modelRef,
      });
      if (this.teamReady || this.nativeReady || lease.agentRuntime) {
        adoption.mark();
        await patchConfig(this.client, (config) => {
          const agents = config.agents;
          const arrayKey = Array.isArray(agents.entries) ? "entries" : "list";
          const managed = !!(this.teamReady || this.nativeReady);
          // Live writes keep the managed paths even before the Gateway reports readiness.
          const configure = (entry = {}) =>
            agentEntry(entry, assistant, {
              teamsReady: !!this.teamReady?.(),
              nativeReady,
              guardProven: !!this.writeGuard?.(),
              agentRuntime: lease.agentRuntime,
              toolsManaged: managed,
              memoryManaged: !!this.nativeReady,
              available,
              pathPrepend,
              mcpTools,
              senderFacing,
            });
          const keyed = agents.entries && !Array.isArray(agents.entries);
          const keyedEntry = () => {
            const current = agents.entries[assistant.runtimeAgentId];
            const next = configure(current);
            // A merge patch keeps omitted keys: null removes a lowered level's
            // override and keys the new level does not set (strictInlineEval).
            const before = current?.tools?.exec;
            if (managed && before && typeof before === "object")
              next.tools = {
                ...next.tools,
                exec: next.tools.exec
                  ? {
                      ...Object.fromEntries(
                        Object.keys(before).map((key) => [key, null]),
                      ),
                      ...next.tools.exec,
                    }
                  : null,
              };
            return next;
          };
          const patch = keyed
            ? { entries: { [assistant.runtimeAgentId]: keyedEntry() } }
            : {
                [arrayKey]: (agents[arrayKey] || []).map((a) =>
                  a.id === assistant.runtimeAgentId ? configure(a) : a,
                ),
              };
          if (this.hostCapacity)
            patch.defaults = { maxConcurrent: this.hostCapacity() + 8 };
          // OpenClaw refuses to drop array items unless their exact path is named:
          // removing or changing the exec override drops pathPrepend entries.
          const replacePaths = keyed
            ? [
                `agents.entries.${assistant.runtimeAgentId}.tools.allow`,
                `agents.entries.${assistant.runtimeAgentId}.tools.exec.pathPrepend`,
              ]
            : [`agents.${arrayKey}`];
          const globalAllow = shellAllow(config.tools?.allow, shellGlobal);
          if (globalAllow) replacePaths.push("tools.allow");
          return {
            patch: {
              agents: patch,
              ...(globalAllow && { tools: { allow: globalAllow } }),
            },
            replacePaths,
          };
        });
      }
      const file = await this.client.call("agents.files.get", {
        agentId: assistant.runtimeAgentId,
        name: "AGENTS.md",
      });
      await this.client.call("agents.files.set", {
        agentId: assistant.runtimeAgentId,
        name: "AGENTS.md",
        content: bootstrap,
        ...(file.file?.missing
          ? { expectedMissing: true }
          : file.file?.hash
            ? { expectedHash: file.file.hash }
            : {}),
      });
      const effective = await this.client.call("config.get", {});
      const entries = effective.config?.agents?.entries;
      const entry = Array.isArray(entries)
        ? entries.find((a) => a.id === assistant.runtimeAgentId)
        : entries?.[assistant.runtimeAgentId];
      const legacy = effective.config?.agents?.list?.find(
        (a) => a.id === assistant.runtimeAgentId,
      );
      if (
        (this.teamReady || this.nativeReady) &&
        !isDeepStrictEqual((entry || legacy)?.tools?.allow, allowed)
      )
        throw assistantProblem("conflict", 409);
      if (
        (this.teamReady || this.nativeReady) &&
        // OpenClaw's merge keeps existing keys first: compare regardless of key order.
        !isDeepStrictEqual((entry || legacy)?.tools?.exec ?? null, exec ?? null)
      )
        throw assistantProblem("conflict", 409);
      if (
        shellGlobal !== undefined &&
        shellAllow(effective.config?.tools?.allow, shellGlobal) !== null
      )
        throw assistantProblem("conflict", 409);
      if (
        this.nativeReady &&
        (entry || legacy)?.memory?.search?.enabled !==
          (nativeReady && capabilities.memory)
      )
        throw assistantProblem("conflict", 409);
      if (
        lease.agentRuntime &&
        (entry || legacy)?.models?.[lease.agentRuntime.model]?.agentRuntime?.id !==
          lease.agentRuntime.id
      )
        throw assistantProblem("conflict", 409);
      const model = (entry || legacy)?.model;
      if ((typeof model === "string" ? model : model?.primary) !== lease.modelRef)
        throw assistantProblem("conflict", 409);
      const readback = await this.client.call("agents.files.get", {
        agentId: assistant.runtimeAgentId,
        name: "AGENTS.md",
      });
      if (readback.file?.content !== bootstrap) throw assistantProblem("conflict", 409);
      await this.verifyBootstrap(assistant, bootstrap);
      // A turn admitted next must run with this config, not the previous one.
      await adoption.settle(base.hash, effective.hash);
      this.store.markEffective(id, assistant.revision);
      this.applied.set(id, fingerprint);
      // The Gateway now runs the stored profile, its shell level included.
      this.onApplied?.(id);
      return {
        revision: assistant.revision,
        effectiveRevision: assistant.revision,
        status: "applied",
      };
    } finally {
      adoption?.close();
      lease.release();
    }
  }
}
