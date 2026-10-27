# Skill catalog for agents (AGENTPIER-182)

## Intent

Today **Agent › Skills** only switches on OpenClaw's bundled skills, per agent. CLI
skills are installed per CLI profile under Extensions (SKILL.md, folder or zip upload,
or a GitHub repo, with scan, preview, warnings, digest and updates;
`server/features/extensions/skill-*.js`). The owner wants to give agents their own
skills the same way: install a skill once into a shared catalog, then switch it on per
agent. Owner decisions from 2026-10-21 (Plane ticket) and confirmations from
2026-10-27 are binding below.

## Goals

1. **Catalog install** (owner only): upload a SKILL.md, upload a zip, or take it from a
   repo. Reuses the CLI skill install flow: scan, preview, warnings, digest (the update
   path is new, see below). One catalog for all agents.
2. **Switch on per agent**: catalog skills appear in every agent's **Agent › Skills**
   next to the bundled ones; the owner switches them on per agent. No assignment step
   at install time.
3. **Shell and binary needs** *(confirmed)*: the catalog shows when a skill needs a
   shell or specific programs (from the scan / the skill's metadata). On an agent
   without shell the skill is marked "works with limits" (still switchable).
4. **Read-only for agents** *(confirmed)*: agents can read skill files but never change
   them; the catalog copy is the only source.
5. **Updates** *(confirmed)*: a catalog update applies to every agent that has the skill
   switched on.
6. **Backups** *(confirmed)*: backups include the catalog and each agent's switches.
7. **Restricted users** (AGENTPIER-180): the owner may switch catalog skills on for
   users' agents, including shared ones. Users never switch skills on or off, at any
   level. The hard lock still applies: a skill never brings shell or anything else the
   agent's lock excludes.
8. **Removing** a skill from the catalog switches it off on every agent (with a
   confirmation that names the agents using it). *(Claude's call.)*

## Non-goals

- CLIs keep their per-profile skills; the catalog is built so CLIs can use it later,
  but this change does not wire it to CLIs.
- No skill marketplace or remote search beyond the existing repo source.
- Agents cannot install or edit skills themselves.

## Decided details *(Claude's calls unless marked)*

- **Where**: catalog management under the same place agent capabilities are managed
  (an **Agents › Skills** catalog page or section, next to the runtime/agent settings);
  the per-agent switch stays in **Agent › Skills** (`07ad40b09` "show and switch agent
  skills in Capabilities"). Builder picks the exact page following existing navigation.
- **Name clashes**: a catalog skill with the same name as a bundled skill or another
  catalog skill is refused at install with a clear reason (existing `skillShadows`
  handling in `runtime-config.js` shows the runtime already cares about shadowing).
- **Storage**: under the data dir, owned by AgentPier, one directory per skill and
  version by digest; the runtime sees it read-only.
- **Audit**: install, update, remove and per-agent switches are audited (ids only).
- de + en copy, `npm run i18n:confirm`; UI only from `docs/ui-guide.md`.

## Runtime mechanism (verified in OpenClaw 2026.10.7 docs and code)

- One AgentPier-owned catalog root in `skills.load.extraDirs` (source
  `openclaw-extra`); each agent's `agents.entries.<id>.skills` allow list filters it
  per agent (AgentPier already writes these lists, `agents.defaults.skills: []`).
  Agents read skill files through OpenClaw's skill read roots even with
  `tools.fs.workspaceOnly`. Workspace skills are not used (agents can write them).
- Lock `skills.load` in `openclaw-config/locked-core.js` so owner overrides cannot
  change it. Only the current version of each skill lives under the scanned root
  (OpenClaw keys skills by frontmatter `name`); older versions stay outside it, or
  use `skills.load.allowSymlinkTargets` if a link layout is chosen.
- AgentPier's own rule that only bundled skills are assignable must change:
  `agent-skills.js` `skillCatalog` (non-bundled shown as `shadowed`),
  `AgentSkills.check`, `agent-entry.js:56-63`.
- Shadowing: every other tier (workspace, `.agents/skills`, managed, personal,
  plugin) outranks extra dirs. `skill-shadows.js` must cover catalog names too, and a
  catalog skill later shadowed by a bundled skill of a runtime update is shown as
  shadowed in the catalog and on the agent.
- Confirm with a native contract test before building UI.

## Corrections and calls after the builder check *(Claude's calls)*

- **Shell/program needs** come from OpenClaw's `skills.status` report
  (`requirements.bins`/`anyBins`, already mapped to `usesShell` in `agent-skills.js`),
  not from AgentPier's scan (which checks content safety only).
- **Read-only**: agents get no write path through file tools (catalog outside any
  workspace). An agent with shell runs as the owner's OS user and could still change
  files; that is the existing shell trust model (`docs/assistant-gateway.md`). As
  defence, every config apply checks each catalog skill's digest and restores a
  tampered copy from the catalog store. The docs state this gap like the existing
  shell notes. User agents never have shell, so they are unaffected.
- **Members**: catalog switches go into the same agent `skills` list. A temporary
  member inherits its lead's skills as today; a member kept as permanent keeps them.
  Temporary members have no own Skills page (unchanged).
- **Update** = a new version of an existing catalog skill: uploading it again (same
  name) or **Check for update** on a repo skill (re-fetch the ref, compare digest).
  No automatic background checks. Preview and scan run again; if the new version has
  new warnings or is blocked, the owner must confirm before it replaces the old one
  for all enabled agents. The existing CLI flow has no update path (it refuses an
  existing folder with 409), so this is new.
- **Skills needing API keys or env** (`skills.entries.<key>.env/apiKey`): not in this
  version. Such skills install, show "needs settings — not supported yet" and stay
  unavailable; follow-up ticket.

## Tests and docs

- Unit/integration: install from each source, scan warnings, digest/update applying to
  all enabled agents, removal switching off, restricted-user rules, read-only mount,
  name clash refusal, backup contents.
- Native contract test: an agent with a catalog skill switched on sees it in its skill
  list and can read it; one without does not. Add to
  `scripts/assistant-contract-shards.json`.
- Browser test for catalog install and the per-agent switch (one run in English).
- Docs: `docs/agents.md` (Skills), `docs/shared-cli-extensions.md` if the scan flow
  wording is shared, `docs/backups.md`, `docs/users.md` (restricted users), README.
