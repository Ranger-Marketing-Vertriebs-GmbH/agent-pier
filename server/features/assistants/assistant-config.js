import { createHash } from "node:crypto";
import path from "node:path";
import {
  inheritsFromLead,
  personalCapabilities,
  personalShell,
  personalSkills,
  profileTools,
  senderLockedTools,
} from "./native-capabilities.js";
import { assistantProblem } from "./assistant-validation.js";
import { assertWired } from "./service-wiring.js";
import { mayCreateProjects, mayOpenPreviews } from "./goal-turns.js";
import { assistantBootstrap } from "./assistant-bootstrap.js";
import { ownProcessInputs } from "./own-process-guidance.js";
import { mirrorLeadMemory } from "./member-memory.js";
import { needsSettings, ownCopy } from "./agent-skills.js";
import {
  builtInSkillNames,
  compiledSkillNames,
  pluginSkillReported,
} from "./built-in-skills.js";
import { compilerFor, ownProcess, runtimeFor } from "./runtimes/runtime-for.js";
import { desiredAgent } from "./agent-desired-state.js";
// Bootstrap files the Gateway exposes besides AGENTS.md. AgentPier never creates
// them (skipBootstrap), so any content is foreign and is neutralized. USER.md is
// the owner's preference note and stays under owner control.
const foreignBootstrap = ["SOUL.md", "IDENTITY.md", "BOOTSTRAP.md"];
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

export class AssistantConfig {
  constructor({
    runtime,
    models,
    store,
    workspaces,
    teamReady,
    hostCapacity,
    adoption = {},
    roster = {},
  }) {
    // `roster`: agents.waitListed options (timeoutMs, and a clock for tests).
    // `runtime`: the runtime supervisor.
    Object.assign(this, {
      runtime,
      models,
      store,
      workspaces,
      teamReady,
      hostCapacity,
      adoption,
      roster,
    });
    this.queue = Promise.resolve();
    this.pending = new Map();
    this.applied = new Map();
    // The skill list each agent's last apply wrote (AgentSkills.reapply).
    this.compiledSkills = new Map();
  }
  // The configuration compiler of the agents' runtime (config sub-port, runtime-for.js).
  get compiler() {
    return compilerFor(null);
  }
  reset() {
    this.applied.clear();
    this.compiledSkills.clear();
  }
  /**
   * The skill names an apply compiles for the agent (agentEntry): its bundled and
   * catalog skills plus the built-in ones it is eligible for, once native tools are
   * ready.
   */
  skillNames(assistant) {
    if (!this.nativeReady?.()) return [];
    return compiledSkillNames(assistant);
  }
  /**
   * Keeps only the names the Gateway reports as the skill AgentPier means: a built-in
   * skill only as the team plugin's own copy (built-in-skills.js), a catalog skill
   * only as the catalog's own live copy (`catalogSource`, below its liveRoot,
   * reported by no other source and needing no settings), any other name only as the
   * bundled skill. Fails closed: without a report (an error, or none) nothing is
   * verified, and `complete` is false so the apply is not cached and asks again next
   * time. A name the report resolves elsewhere is dropped reliably and the apply is
   * cached: skills.changed and the ready re-apply bring it back once that changes.
   */
  async verifySkills(assistant, names) {
    if (!names.length) return { skills: [], complete: true };
    const report = await runtimeFor(assistant, this.runtime)
      .skills.status({ agentId: assistant.runtimeAgentId })
      .catch(() => null);
    if (!Array.isArray(report?.skills)) return { skills: [], complete: false };
    // A catalog that cannot be read names no skill: none of its copies compiles.
    let catalog = new Set();
    try {
      catalog = this.skillCatalog?.names() || catalog;
    } catch {
      /* Fails closed below: a catalog name then needs the bundled skill. */
    }
    const liveRoot = this.skillCatalog?.liveRoot;
    const reported = (name) => report.skills.filter((entry) => entry?.name === name);
    // The runtime root holds the workspaces, the Gateway's state and the plugins.
    const runtimeRoot = this.workspaces && path.dirname(this.workspaces);
    const kept = (name) => {
      const entries = reported(name);
      if (builtInSkillNames.includes(name))
        return pluginSkillReported(entries, runtimeRoot);
      if (!catalog.has(name))
        return entries.some((entry) => entry.source === "openclaw-bundled");
      return (
        entries.length > 0 &&
        entries.every((entry) => ownCopy(entry, liveRoot) && !needsSettings(entry))
      );
    };
    return { skills: names.filter(kept), complete: true };
  }
  /**
   * Checks the given names' catalog copies (a tampered one is restored from the store)
   * and names those the compile must leave out (`dropped`): damaged, needing settings
   * or not checked. Never throws: a check that fails drops every catalog name it covers
   * for this apply only. A catalog that cannot be read is `unreadable`, which the
   * fingerprint carries, so the apply asks verifySkills, which keeps no catalog name.
   */
  catalogCheck(names) {
    const catalog = this.skillCatalog;
    if (!catalog || !names.length) return { dropped: [], unreadable: false };
    let checked = true;
    try {
      catalog.verify(names, { cached: true });
    } catch {
      checked = false;
    }
    try {
      if (checked) return { dropped: catalog.dropped(names), unreadable: false };
      const known = catalog.names();
      return { dropped: names.filter((name) => known.has(name)), unreadable: false };
    } catch {
      return { dropped: [], unreadable: true };
    }
  }
  /** The list an apply would compile now (disk scan, then the Gateway's view). */
  async expectedSkills(assistant) {
    const assigned = this.skillNames(assistant);
    const shadowed = [
      ...this.compiler.shadowedSkills(path.dirname(this.workspaces), assistant, assigned),
      ...this.catalogCheck(assigned).dropped,
    ];
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
    const { agentFiles } = runtimeFor(assistant, this.runtime);
    for (const name of ["AGENTS.md", ...foreignBootstrap]) {
      const expected = name === "AGENTS.md" ? bootstrap : "";
      const read = async () =>
        (await agentFiles.get({ agentId: assistant.runtimeAgentId, name })).file;
      const intact = (file) =>
        file?.missing === true
          ? name !== "AGENTS.md" || expected === ""
          : file?.hash
            ? file.hash === sha256(expected)
            : file?.content === expected;
      const file = await read();
      if (intact(file)) continue;
      await agentFiles.set({
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
  // The agent's granted secrets file, rewritten before each turn so a deleted or
  // edited copy is back (agent-secrets.js); a failure never fails the turn.
  async deliverSecrets(assistant) {
    await Promise.resolve()
      .then(() => this.syncSecrets?.(assistant.id))
      .catch(() => {});
  }
  /**
   * A Hermes agent (ADR 0006 decision 4): its own process set runs only its desired
   * state, written into its home by the runtime's config sub-port, which starts the
   * set or restarts it when the home changed; an archived agent's set stops. Its
   * catalog skills are checked first (a tampered copy is restored, a damaged one left
   * out) and offered from their live folders; its bound MCP servers come from the
   * store (`ownMcp`, mcp-changes.js agentInputs); the team bridge its team plugin
   * calls comes from `hermesInputs`; its SSH grant, shell PATH and the guidance on
   * what its AgentPier tools reach from `ownProcessInputs` (own-process-guidance.js).
   */
  async applyOwnProcess(assistant, lease) {
    const runtime = runtimeFor(assistant, this.runtime);
    if (assistant.archivedAt) await runtime.host.stop();
    else {
      const assigned = personalSkills(assistant);
      const { dropped } = this.catalogCheck(assigned);
      let known = new Set();
      try {
        known = this.skillCatalog?.names() || known;
      } catch {
        /* A catalog that cannot be read offers none of its skills. */
      }
      const catalog = Object.fromEntries(
        assigned
          .filter((name) => known.has(name) && !dropped.includes(name))
          .map((name) => [name, this.skillCatalog.livePath(name)]),
      );
      const mcp = this.ownMcp?.(assistant) || { servers: [], inputs: undefined };
      // The team bridge (and the browser settings) its plugin needs; a lead's team
      // section leaves its members out, which agentpier_team_members lists.
      const inputs = (await this.hermesInputs?.(assistant)) || {};
      let team = null;
      if (inputs.connection && !assistant.teamMemberId)
        try {
          team = this.teamRoster?.(assistant) || null;
        } catch {
          team = null;
        }
      // Its SSH grant, shell PATH and what its AgentPier tools reach, as OpenClaw's.
      const own = await ownProcessInputs(this, assistant, {
        tools: !!inputs.connection,
      });
      const desired = desiredAgent(assistant, {
        ssh: own.ssh,
        shellPath: own.shellPath,
        // A temporary member's browser window follows its lead's setting.
        lead: assistant.parentAssistantId
          ? this.store.listAssistants().find((p) => p.id === assistant.parentAssistantId)
          : null,
        mcp: mcp.servers,
        stdio: mcp.servers.some(
          (id) =>
            mcp.inputs?.servers.find((server) => server.id === id)?.transport === "stdio",
        ),
        instructions: assistantBootstrap(assistant, lease.display, {
          ...own.guidance,
          team: team && { ...team, listed: false },
        }),
        model: {
          ref: lease.modelRef,
          providerId: lease.providerId,
          provider: lease.provider,
          agentRuntime: lease.agentRuntime,
        },
        // Its own Telegram bot for other people (assistant-channels/
        // telegram-senders-own.js), wired by TelegramSenders; unknown without it.
        channelBot: this.channelBot?.(assistant),
      });
      await runtime.config.apply({
        desired,
        strict: assistant.shell === "approval" && assistant.shellEveryCommand === true,
        catalog,
        mcp: mcp.inputs,
        connection: inputs.connection,
        browser: inputs.browser,
        web: inputs.web,
      });
    }
    this.store.markEffective(assistant.id, assistant.revision);
    this.onApplied?.(assistant.id);
    return {
      revision: assistant.revision,
      effectiveRevision: assistant.revision,
      status: "applied",
    };
  }
  apply(id) {
    const task = this.queue.catch(() => {}).then(() => this.applyOnce(id));
    this.queue = task;
    // Waiting or running applies per agent: a delete waits for them (agent-lifecycle.js).
    this.pending.set(id, (this.pending.get(id) || 0) + 1);
    const settle = () => {
      const left = this.pending.get(id) - 1;
      if (left) this.pending.set(id, left);
      else this.pending.delete(id);
    };
    task.then(settle, settle);
    return task;
  }
  /** Whether an apply of the agent waits or runs now. */
  applying(id) {
    return this.pending.has(id);
  }
  async applyOnce(id) {
    assertWired(this);
    const assistant = this.store.getAssistant(id),
      lease = await this.models.resolve(assistant.model);
    if (ownProcess(assistant))
      try {
        return await this.applyOwnProcess(assistant, lease);
      } finally {
        lease.release();
      }
    const nativeReady = !!this.nativeReady?.();
    const capabilities = personalCapabilities(assistant);
    // The same availability the Gateway start compiled (webToolsAvailability).
    const available = this.webToolsAvailable?.() || {};
    // The agent's MCP globs the running Gateway was started with (mcpSections).
    const mcpTools = this.mcpTools?.(assistant) || [];
    // An agent whose own bot for other people the Gateway runs has no session tools
    // and no email (senderLockedTools).
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
    ).filter((tool) => !senderFacing || !senderLockedTools.includes(tool));
    // The agent's SSH agent, synced first so this turn's PATH and instructions name
    // its trusted hosts' aliases (agent-ssh-shell-wiring.js); never fails the turn.
    const plainSsh = nativeReady
      ? await Promise.resolve()
          .then(() => this.plainSsh?.(assistant))
          .catch(() => null)
      : null;
    // The owner's login PATH the running Gateway was started with (exec-shell.js).
    // An agent with GitHub access starts with its GitHub folder (agent-github.js),
    // then its SSH agent's bin/ (agent-ssh-shell.js).
    const shellPath = [
      ...(this.githubShellPath?.(assistant) || []),
      ...(this.sshShellPath?.(assistant) || []),
    ];
    const pathPrepend = [...shellPath, ...(this.shellPathPrepend?.() || [])];
    const compiler = this.compiler;
    // As the agent's entry compiles it; the readback below checks the same value.
    const exec = nativeReady
      ? compiler.agentExec(personalShell(assistant), pathPrepend)
      : undefined;
    // Global tools.allow is an upper bound for every agent; it carries exec and
    // process while some eligible agent has shell. It applies hot (fact c).
    const shellGlobal = nativeReady
      ? (this.store.listAssistants?.() || [assistant]).some(
          (profile) => personalShell(profile) !== "off",
        )
      : undefined;
    // The agent's bundled, catalog and built-in skills (agentEntry), applied hot like
    // tools.allow, without names a same-named skill in its folders would replace
    // (skill-shadows.js). Its catalog copies are checked here, before every turn
    // admission, the unchanged-configuration shortcut included: a tampered copy is
    // restored, and one that is damaged or could not be checked is left out.
    const assigned = this.skillNames(assistant);
    const catalog = this.catalogCheck(assigned);
    const shadowed = [
      ...compiler.shadowedSkills(path.dirname(this.workspaces), assistant, assigned),
      ...catalog.dropped,
    ];
    let skills = assigned.filter((name) => !shadowed.includes(name));
    let gatewayDropped = false;
    const guidance = {
      memoryWritable: !!this.writeGuard?.(),
      // Its granted project folders, resolved now (agent-project-files.js).
      projectFolders: (nativeReady && this.projectFolders?.(assistant)) || [],
      // Its GitHub access: profile, level and the server's tool prefix.
      github: (nativeReady && this.github?.(assistant)) || null,
      // Its trusted hosts' plain ssh aliases, by catalog name (agent-ssh-shell.js).
      plainSsh: plainSsh || null,
      // The image tool this start can serve (web-tools.js availability).
      images: nativeReady && available.createImages === true && !!this.writeGuard?.(),
      // Whether it receives a secrets file; names the file, never its contents.
      secrets: !!this.secretsGranted?.(assistant),
      // The projects it may start coding sessions on (AgentCodingSessions.projects).
      codingSessions: (nativeReady && this.codingSessions?.(assistant)) || [],
      // Its granted email accounts (AgentMail.accounts), by name and id only.
      mailAccounts: (nativeReady && this.mailAccounts?.(assistant)) || [],
      // Whether it holds agentpier_project (profileTools without senderLockedTools).
      projectCreation: nativeReady && mayCreateProjects(assistant, senderFacing),
      previews: nativeReady && mayOpenPreviews(assistant, senderFacing),
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
    // The agent as AgentPier wants it (agent-desired-state.js), which the runtime's
    // config sub-port applies; its grants yield `allowed` above.
    const desired = desiredAgent(assistant, {
      ssh,
      shellPath,
      instructions: bootstrap,
      model: {
        ref: lease.modelRef,
        providerId: lease.providerId,
        provider: lease.provider,
        agentRuntime: lease.agentRuntime,
      },
    });
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
          catalog.unreadable,
          configured,
          senderFacing,
          ssh,
        ]),
      )
      .digest("hex");
    const { agents, agentFiles, config } = runtimeFor(assistant, this.runtime);
    let adoption = null;
    try {
      if (
        this.applied.get(id) === fingerprint &&
        assistant.effectiveRevision === assistant.revision
      ) {
        await this.mirrorMemory(assistant, nativeReady && capabilities.memory);
        await this.deliverSecrets(assistant);
        if (nativeReady) await this.browserProfiles?.sync();
        await this.verifyBootstrap(assistant, bootstrap);
        this.onApplied?.(id);
        return {
          revision: assistant.revision,
          effectiveRevision: assistant.revision,
          status: "applied",
        };
      }
      // Watched before the first write, so the commit cannot be announced unseen.
      adoption = config.watchAdoption(this.adoption);
      const base = adoption.watching ? await config.get() : {};
      if (desired.model.provider) await config.applyModel({ desired });
      // agents.create and agents.update write the configuration: the roster is read
      // once the runtime admitted its agents.
      await agents.settled();
      const roster = await agents.list();
      if (!roster.agents?.some((a) => a.id === assistant.runtimeAgentId)) {
        const created = await agents.create({
          name: assistant.runtimeAgentId,
          workspace: path.join(this.workspaces, assistant.id),
          model: lease.modelRef,
        });
        if (created.agentId !== assistant.runtimeAgentId)
          throw assistantProblem("conflict", 409);
      }
      // Profile creation commits before the Gateway's runtime roster reloads.
      await agents.waitListed({ agentId: assistant.runtimeAgentId, ...this.roster });
      await this.mirrorMemory(assistant, nativeReady && capabilities.memory);
      await this.deliverSecrets(assistant);
      // The Gateway's own view decides as well: a name it resolves to any other
      // source than the bundled skill or the catalog's own copy is never compiled.
      if (skills.length) {
        const verified = await this.verifySkills(assistant, skills);
        shadowed.push(...skills.filter((name) => !verified.skills.includes(name)));
        skills = verified.skills;
        // Not what the fingerprint says: the next apply must ask the Gateway again.
        gatewayDropped = !verified.complete;
      }
      // Its browser profile exists before its entry offers the browser tool.
      if (nativeReady) await this.browserProfiles?.sync();
      // Events count from the last write on; agents.update always writes.
      adoption.mark();
      await agents.update({
        agentId: assistant.runtimeAgentId,
        name: assistant.name,
        model: lease.modelRef,
      });
      if (this.teamReady || this.nativeReady || lease.agentRuntime) {
        adoption.mark();
        await config.apply({
          desired,
          // Read as the write runs.
          state: () => ({
            teamsReady: !!this.teamReady?.(),
            nativeReady,
            guardProven: !!this.writeGuard?.(),
            toolsManaged: !!(this.teamReady || this.nativeReady),
            memoryManaged: !!this.nativeReady,
            available,
            pathPrepend,
            mcpTools,
            senderFacing,
            shadowedSkills: shadowed,
            managed: !!(this.teamReady || this.nativeReady),
            hostCapacity: this.hostCapacity,
            shellGlobal,
          }),
        });
      }
      const file = await agentFiles.get({
        agentId: assistant.runtimeAgentId,
        name: "AGENTS.md",
      });
      await agentFiles.set({
        agentId: assistant.runtimeAgentId,
        name: "AGENTS.md",
        content: bootstrap,
        ...(file.file?.missing
          ? { expectedMissing: true }
          : file.file?.hash
            ? { expectedHash: file.file.hash }
            : {}),
      });
      const effective = await config.get();
      if (
        !config.applied({
          desired,
          config: effective.config,
          expected: {
            managed: !!(this.teamReady || this.nativeReady),
            tools: allowed,
            exec,
            skills,
            shellGlobal,
            memory: this.nativeReady ? nativeReady && desired.memory : undefined,
          },
        })
      )
        throw assistantProblem("conflict", 409);
      const readback = await agentFiles.get({
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
