import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { personalCapabilities, profileTools } from "./native-capabilities.js";
import { assistantProblem } from "./assistant-validation.js";
import { assertWired } from "./service-wiring.js";
import { assistantBootstrap } from "./assistant-bootstrap.js";
// Bootstrap files the Gateway exposes besides AGENTS.md. AgentPier never creates
// them (skipBootstrap), so any content is foreign and is neutralized. USER.md is
// the owner's preference note and stays under owner control.
const foreignBootstrap = ["SOUL.md", "IDENTITY.md", "BOOTSTRAP.md"];
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

export class AssistantConfig {
  constructor({ client, models, store, workspaces, teamReady, hostCapacity }) {
    Object.assign(this, { client, models, store, workspaces, teamReady, hostCapacity });
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
    const allowed = profileTools(
      assistant,
      this.teamReady?.(),
      nativeReady,
      !!this.writeGuard?.(),
    );
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
          bootstrap,
        ]),
      )
      .digest("hex");
    try {
      if (
        this.applied.get(id) === fingerprint &&
        assistant.effectiveRevision === assistant.revision
      ) {
        await this.verifyBootstrap(assistant, bootstrap);
        return {
          revision: assistant.revision,
          effectiveRevision: assistant.revision,
          status: "applied",
        };
      }
      if (lease.provider) {
        const previous = await this.client.call("config.get", {});
        await this.client.call("config.patch", {
          baseHash: previous.hash,
          raw: JSON.stringify({
            models: { providers: { [lease.providerId]: lease.provider } },
          }),
        });
      }
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
      await this.client.call("agents.update", {
        agentId: assistant.runtimeAgentId,
        name: assistant.name,
        model: lease.modelRef,
      });
      if (this.teamReady || this.nativeReady || lease.agentRuntime) {
        const previous = await this.client.call("config.get", {});
        const agents = previous.config.agents;
        const arrayKey = Array.isArray(agents.entries) ? "entries" : "list";
        const configure = (entry = {}) => ({
          ...entry,
          ...(this.teamReady || this.nativeReady ? { tools: { allow: allowed } } : {}),
          ...(this.nativeReady
            ? {
                memory: {
                  search: {
                    enabled: nativeReady && capabilities.memory,
                    rememberAcrossConversations: false,
                  },
                },
              }
            : {}),
          ...(lease.agentRuntime
            ? {
                models: {
                  ...entry.models,
                  [lease.agentRuntime.model]: {
                    ...entry.models?.[lease.agentRuntime.model],
                    agentRuntime: { id: lease.agentRuntime.id },
                  },
                },
              }
            : {}),
        });
        const patch =
          agents.entries && !Array.isArray(agents.entries)
            ? {
                entries: {
                  [assistant.runtimeAgentId]: configure(
                    agents.entries[assistant.runtimeAgentId],
                  ),
                },
              }
            : {
                [arrayKey]: (agents[arrayKey] || []).map((a) =>
                  a.id === assistant.runtimeAgentId ? configure(a) : a,
                ),
              };
        if (this.hostCapacity)
          patch.defaults = { maxConcurrent: this.hostCapacity() + 8 };
        await this.client.call("config.patch", {
          baseHash: previous.hash,
          raw: JSON.stringify({ agents: patch }),
          replacePaths:
            agents.entries && !Array.isArray(agents.entries)
              ? [`agents.entries.${assistant.runtimeAgentId}.tools.allow`]
              : [`agents.${arrayKey}`],
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
        JSON.stringify((entry || legacy)?.tools?.allow) !== JSON.stringify(allowed)
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
      this.store.markEffective(id, assistant.revision);
      this.applied.set(id, fingerprint);
      return {
        revision: assistant.revision,
        effectiveRevision: assistant.revision,
        status: "applied",
      };
    } finally {
      lease.release();
    }
  }
}
