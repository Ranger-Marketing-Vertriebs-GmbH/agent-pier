import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  inheritsFromLead,
  memoryEnabled,
  personalCapabilities,
  personalShell,
  personalSkills,
  profileTools,
  sessionTools,
} from "./native-capabilities.js";
import { assistantProblem } from "./assistant-validation.js";
import { assertWired } from "./service-wiring.js";
import { assistantBootstrap } from "./assistant-bootstrap.js";
import { mirrorLeadMemory } from "./member-memory.js";
import { agentEntry } from "./openclaw-config/agent-entry.js";
import { shadowedSkills } from "./openclaw-config/skill-shadows.js";
import { patchConfig } from "./openclaw-config/live-patch.js";
import { watchConfigAdoption } from "./openclaw-config/config-adoption.js";
import { waitForAgentInRoster } from "./openclaw-config/agent-roster.js";
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
    roster = {},
  }) {
    // `roster`: waitForAgentInRoster options (timeoutMs, and a clock for tests).
    Object.assign(this, {
      client,
      models,
      store,
      workspaces,
      teamReady,
      hostCapacity,
      adoption,
      roster,
    });
    this.queue = Promise.resolve();
    this.applied = new Map();
    // The skill list each agent's last apply wrote (AgentSkills.reapply).
    this.compiledSkills = new Map();
  }
  reset() {
    this.applied.clear();
    this.compiledSkills.clear();
  }
  /**
   * Keeps only the names the Gateway reports as the bundled skill for this agent.
   * Fails closed: without a report (an error, or none) nothing is verified, and
   * `complete` is false so the apply is not cached and asks again next time. A
   * name the report resolves elsewhere is dropped reliably and the apply is cached:
   * skills.changed and the ready re-apply bring it back once that changes.
   */
  async verifySkills(assistant, names) {
    if (!names.length) return { skills: [], complete: true };
    const report = await this.client
      .call("skills.status", { agentId: assistant.runtimeAgentId })
      .catch(() => null);
    if (!Array.isArray(report?.skills)) return { skills: [], complete: false };
    const bundled = new Set(
      report.skills
        .filter((entry) => entry?.source === "openclaw-bundled")
        .map((entry) => entry.name),
    );
    return { skills: names.filter((name) => bundled.has(name)), complete: true };
  }
  /** The list an apply would compile now (disk scan, then the Gateway's view). */
  async expectedSkills(assistant) {
    const assigned = this.nativeReady?.() ? personalSkills(assistant) : [];
    const shadowed = shadowedSkills(path.dirname(this.workspaces), assistant, assigned);
    return (
      await this.verifySkills(
        assistant,
        assigned.filter((name) => !shadowed.includes(name)),
      )
    ).skills;
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
  // A temporary member's memory is a read-only copy of its lead's, refreshed before
  // each turn; a failed copy leaves the previous one (member-memory.js).
  async mirrorMemory(assistant, enabled) {
    if (inheritsFromLead(assistant))
      await mirrorLeadMemory(this.workspaces, assistant, enabled).catch(() => {});
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
    // The agent holds an SSH grant (assistant-access.js); the Gateway start uses the same.
    const ssh = !!this.sshGranted?.(assistant);
    const allowed = profileTools(
      assistant,
      this.teamReady?.(),
      nativeReady,
      !!this.writeGuard?.(),
      available,
      mcpTools,
      ssh,
    ).filter((tool) => !senderFacing || !sessionTools.includes(tool));
    // The owner's login PATH the running Gateway was started with (exec-shell.js).
    // An agent with GitHub access starts with its GitHub folder (agent-github.js).
    const pathPrepend = [
      ...(this.githubShellPath?.(assistant) || []),
      ...(this.shellPathPrepend?.() || []),
    ];
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
    // The agent's bundled skills (agentEntry), applied hot like tools.allow, without
    // names a same-named skill in its folders would replace (skill-shadows.js).
    const assigned = nativeReady ? personalSkills(assistant) : [];
    const shadowed = shadowedSkills(path.dirname(this.workspaces), assistant, assigned);
    let skills = assigned.filter((name) => !shadowed.includes(name));
    let gatewayDropped = false;
    const guidance = {
      memoryWritable: !!this.writeGuard?.(),
      // Its granted project folders, resolved now (agent-project-files.js).
      projectFolders: (nativeReady && this.projectFolders?.(assistant)) || [],
      // Its GitHub access: profile, level and the server's tool prefix.
      github: (nativeReady && this.github?.(assistant)) || null,
      // The image tool this start can serve (web-tools.js availability).
      images: nativeReady && available.createImages === true && !!this.writeGuard?.(),
    };
    // A lead's "Your team" section names its members as they are now. It changes
    // with every busy member, so it stays out of the fingerprint: verifyBootstrap
    // writes the new AGENTS.md without applying the whole configuration again.
    // `teamRoster` answers null while the team tools are not offered.
    let team = null;
    if (!assistant.teamMemberId && !assistant.archivedAt)
      try {
        team = this.teamRoster?.(assistant) || null;
      } catch {
        team = null;
      }
    const bootstrap = assistantBootstrap(assistant, lease.display, { ...guidance, team });
    const configured = team
      ? assistantBootstrap(assistant, lease.display, guidance)
      : bootstrap;
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
          skills,
          configured,
          senderFacing,
          ssh,
        ]),
      )
      .digest("hex");
    let adoption = null;
    try {
      if (
        this.applied.get(id) === fingerprint &&
        assistant.effectiveRevision === assistant.revision
      ) {
        await this.mirrorMemory(assistant, nativeReady && capabilities.memory);
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
      // Profile creation commits before the Gateway's runtime roster reloads.
      await waitForAgentInRoster(this.client, assistant.runtimeAgentId, this.roster);
      await this.mirrorMemory(assistant, nativeReady && capabilities.memory);
      // The Gateway's own view decides as well: a name it resolves to any other
      // source than the bundled skill is never compiled.
      if (skills.length) {
        const verified = await this.verifySkills(assistant, skills);
        shadowed.push(...skills.filter((name) => !verified.skills.includes(name)));
        skills = verified.skills;
        // Not what the fingerprint says: the next apply must ask the Gateway again.
        gatewayDropped = !verified.complete;
      }
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
              ssh,
              shadowedSkills: shadowed,
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
            // A merge patch keeps an omitted list: null removes the last skill, and the
            // hard lock's deny of an agent that is no user agent any more.
            if (managed && Array.isArray(current?.skills) && !next.skills)
              next.skills = null;
            if (managed && Array.isArray(current?.tools?.deny) && !next.tools?.deny)
              next.tools = { ...next.tools, deny: null };
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
          // A shorter or removed skill list drops array items as well.
          if (keyed && Array.isArray(agents.entries[assistant.runtimeAgentId]?.skills))
            replacePaths.push(`agents.entries.${assistant.runtimeAgentId}.skills`);
          if (
            keyed &&
            Array.isArray(agents.entries[assistant.runtimeAgentId]?.tools?.deny)
          )
            replacePaths.push(`agents.entries.${assistant.runtimeAgentId}.tools.deny`);
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
        (this.teamReady || this.nativeReady) &&
        !isDeepStrictEqual((entry || legacy)?.skills ?? [], skills)
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
          (nativeReady && memoryEnabled(assistant))
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
      if (gatewayDropped) this.applied.delete(id);
      else this.applied.set(id, fingerprint);
      this.compiledSkills.set(id, skills);
      // The Gateway now runs the stored profile, its shell level included; a lead's
      // running members follow what changed (member-follow.js).
      this.onReapplied?.(id);
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
