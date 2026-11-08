# Craft Anything in AgentPier — design

Status: draft for owner review, 2026-11-08. Working document; delete it with the PR that
finishes the work (AGENTS.md).

## Intent

AgentPier already offers [REA](../../mcp.md#managed-rea) as an optional, managed
reverse-engineering tool. The owner wants to offer
[Craft Anything](https://github.com/storytold/craft-anything) (`storytold/craft-anything`,
Rust, Apache-2.0/MIT, early alpha, v0.5.0 on 2026-11-06) as well, for two things:

1. **Analysis tools in sessions**, like REA today: a managed MCP server the coding CLIs
   can use.
2. **Rebuilds**: "make my own version of this website / app / game". Craft Anything
   studies a target, has a coding agent build a new project, checks the result against
   the original and refines it.

The hard part is (2): Craft Anything's rebuild starts its **own** Claude Code process
(`claude -p … --output-format stream-json`). The owner chose to let Craft Anything
orchestrate the rebuild (its loop, prompts and checks are the value) and to have
AgentPier **supervise** it cleanly: which account builds, where the files go, every
question and approval reaching the owner, visible progress, no orphaned processes.

## Goals

- One-click managed install of Craft Anything, like REA: pinned release, verified
  checksum, update path for existing installs, installer flag.
- Craft Anything's analysis tools available to sessions as a managed MCP server.
- An owner-only **Craft** area to start, follow, answer and continue rebuilds.
- Every rebuild becomes an AgentPier project automatically, in its own new folder.
- AgentPier, not Craft Anything, decides: the builder account, the project folder, the
  auto mode, clean room vs. deep, consent to start.
- Questions and approvals from a running build reach the owner as inbox items with push
  notifications, like a session's questions, and are answered from AgentPier. (Ordinary
  inbox items do not go to Telegram; Telegram is each agent's own paired chat. No new
  Telegram path.)
- Sessions and agents can start a rebuild, but only through AgentPier.

## Non-goals (for now)

- Restricted users (user app). Rebuilds and the Craft area are owner only.
- Codex, OpenCode or API-key builders. Craft Anything has not verified Codex live;
  only Claude Code is offered.
- Craft Anything's desktop app, its own setup (`craft-anything-cli setup`), its asset
  generation (fal.ai), Frida/ADB extras, plugins.
- Reworking project identity (AGENTPIER-285, paused).
- A model choice or a cost limit per rebuild (owner, 2026-11-08: stays as it is).
  Craft Anything's own model setting and its round limit apply; usage is shown.
- Starts from pipelines, routines or hooks.

## Anti-goals (failure even if it works)

- A Claude process AgentPier does not know about: started by an agent calling
  Craft Anything's `rebuild_start` itself, or left running after AgentPier or the
  supervising process ends.
- Builds that silently decide questions or allow commands (Craft Anything's default
  auto mode does both; see Findings).
- Files appearing outside the project folder AgentPier chose (Craft Anything's default
  is `~/Documents/Craft Anything`).
- Craft Anything's captures of someone else's site (`capture/`, `checks/`: screenshots,
  rendered HTML, fonts) ending up in Git. What the builder writes into `app/` is the
  owner's code like any other; Craft Anything already tells the builder not to copy
  logos, photos or text unless the owner owns them.
- A second Ghidra/JDK download when REA already installed the same pinned versions.

## Findings from the spike (2026-11-08)

A throwaway spike ran the macOS universal CLI 0.5.0 with a disposable
`CRAFT_ANYTHING_CONFIG_DIR`, first against a fake `claude` that recorded its
invocation, then once with the owner's real Claude Code (built a hello-world page in
~30 s, ~152k input / 2k output tokens, Craft Anything estimated $0.15). What held:

- **Distribution.** Release assets carry `SHA256SUMS.txt` (plus `.asc`). macOS:
  `craft-anything-cli-<ver>-macos-universal.zip` (signed, notarized, ~65 MB binary;
  download from code, not a browser, to avoid the quarantine check). Linux:
  `craft-anything-<ver>-linux-{x86_64,aarch64}.tar.gz`, `bin/craft-anything-cli` inside
  (the GUI binary beside it is not needed). Checksums of both matched.
- **Config isolation.** `CRAFT_ANYTHING_CONFIG_DIR` moves settings (`config.toml`), logs
  and Craft Anything's engine store. `CRAFT_ANYTHING_NO_KEYCHAIN=1` keeps it out of the
  keychain.
- **AgentPier as MCP client works.** `craft-anything-cli mcp --all-tools --allow-run`
  as a child over stdio. `--allow-run` means the client does its own consent
  (without it `rebuild_start` returns `consent_required`; there is no elicitation).
  Then:
  - `rebuild_start {request, target ("-" for none, a URL or an absolute path),
    build_with?, rounds?, project_folder?, existing?, projects_dir?, resume?, project?}`
    → `{project, started}`. The build runs **inside that MCP server process**
    (in the background, at most `build.parallel` = 2 at once, more are queued).
  - `rebuild_status {project}` → `running`, `queued`, `status` (`building`, `ready`,
    `needs_you`, …), `note`, `waiting` (count).
  - `project_show {project}` → status, checks, `usage`, `questions[]` with
    `{id, kind: "question"|"approval", title, detail, choices, allow_text, action}`.
  - `project_inbox_answer {project, id, choice?|text?|allow?, always?}` unblocks the
    waiting builder at once.
  - `project_questions_set {project, mode: ask|decide|default}` (works mid-build),
    `rebuild_activity_show` (every stage, command, file and reply), `rebuild_stop`
    (not exercised), `rebuild_note` (tell a running build something).
- **Account.** Craft Anything starts `claude` from `PATH` (or a configured backend
  `command`) and the child inherits the environment, including `CLAUDE_CONFIG_DIR`.
  With an AgentPier account's profile directory the build ran on that account and its
  transcript landed in that profile (`projects/<cwd-slug>/<session>.jsonl`); the
  session id is in `craft.json` (`agent_session`). It passes `--model claude-opus-5-5`
  from its own backend settings.
- **Project folder.** `craft.json` (request, target, stack, status, checks,
  `agent_session`), `usage.json`, `build-activity.log`, `feed.json`, `capture/`,
  `checks/`, `inbox/`, `investigation.cany/`, and the code in `app/`. With
  `existing: edit` the code is the folder itself, but the records still sit beside it.
- **Pitfalls that the integration must handle:**
  1. **Auto mode is on by default** (`auto_mode = true`): questions are answered with
     "decide yourself" and approvals such as `curl https://example.com` are allowed
     without asking. With `auto_mode = false` and `project_questions_set ask` both
     reached the inbox.
  2. **Ghidra discovery blocks.** With no `engines.ghidra.install_dir` set,
     `doctor`, `capabilities` and `rebuild` hung for minutes in a `read_dir` over the
     usual folders (`$HOME`, `~/Downloads`, `/Applications`, …). Setting
     `install_dir` skips the search. `engines.only_configured` is test-only
     (`serde(skip)`) and cannot be used.
  3. **Default projects folder.** Without `projects_dir`/`project_folder` it writes to
     `~/Documents/Craft Anything`.
  4. **Orphans.** When the MCP server process died mid-build, the builder and its own
     MCP server child kept running, waiting on the inbox.
  5. **Stack guessing.** Without `build_with`, "a static hello world HTML page" was
     planned as Rust + egui. Valid `build_with` values come from its list ("Builder's
     choice", "Plain HTML and CSS", "React + TypeScript (Vite)", "Next.js + TypeScript",
     "Python", "Electron", "Rust (console)", "Rust + egui (eframe)", "unity", "unreal",
     "godot"); read it from the tool's error/schema rather than hard-coding where
     possible.
- **Versions line up with REA.** Craft Anything 0.5.0 pins Ghidra **12.1.4** and a
  Temurin **JDK 21** (21.0.12.1+1); REA's manifest pins Ghidra 12.1.4 and JDK
  21.0.13+9. Craft Anything takes `engines.ghidra.install_dir` and
  `engines.ghidra.java_home`.

## Decisions

### 1. Managed install

- A new managed tool `craft-anything`, modelled on REA (`server/features/tools/rea-*`):
  a manifest with pinned version, per-platform URL, SHA-256 (from `SHA256SUMS.txt`,
  re-verified by download), sizes; verified download; unpack into
  `<dataDir>/clis/.packages/…`, activated through a link, like REA's components.
  Platforms: darwin-arm64 and darwin-x64 (universal zip), linux-x64, linux-arm64.
- A card and dialog beside REA under **CLIs and extensions › Installation**, with the
  components and sizes before download; **Update** when AgentPier pins a newer
  release (same rule as REA in `docs/cli-updates.md`).
- `scripts/` installer: `--with-craft-anything`, through the install and the update
  path for existing installations (AGENTS.md: no manual fixes).
- AgentPier owns Craft Anything's `config.toml` in its own config dir
  (`CRAFT_ANYTHING_CONFIG_DIR=<dataDir>/craft-anything`), always with:
  `auto_mode = false`, `engines.ghidra.install_dir` and `java_home` set (to the shared
  Ghidra/JDK, or to a path that disables discovery when none is installed),
  projects folder never used (every call passes `project_folder`), and
  `CRAFT_ANYTHING_NO_KEYCHAIN=1` in its environment.

### 2. Ghidra and JDK shared with REA

- Ghidra and the JDK become **shared managed components** instead of REA-only
  (`rea-ghidra`, `rea-jdk` today). One pin serves both tools. Existing REA installs are
  taken over in place, without downloading again.
- Both dialogs offer the component; when the other tool installed it, the row reads as
  already installed and shared.
- Ghidra is optional for Craft Anything: clean room never needs it, deep mode works
  without it (own decompilers) and better with it.
- Removing one tool keeps a component the other still uses; it goes only when neither
  needs it.
- **One pin, AgentPier's.** The shared component has a single pinned version (today
  REA's Ghidra 12.1.4 and JDK 21.0.13+9); Craft Anything is pointed at it through
  `install_dir`/`java_home` and never downloads its own. Craft Anything 0.5.0 pins the
  same Ghidra and the same JDK major (21.0.12.1+1), so this holds. Raising Craft
  Anything to a release that needs another Ghidra major means raising the shared pin,
  checked against both tools; no side-by-side versions. (Claude's call.)

### 3. Analysis tools in sessions

- A managed MCP server row, like REA's, running `craft-anything-cli mcp` with
  AgentPier's environment, clean room by default.
- The rebuild tools that start their own coding agent — `rebuild_start`,
  `rebuild_question_ask`, and any tool that does the same — are **not available** to
  sessions. Whether that is done by a server flag, `--restricted` with its allow
  flags, or a tool filter in AgentPier is the builder's call; the rule is that no
  session can start a Claude process through Craft Anything.
- Craft Anything's skill (`crates/setup/src/skill.md`) ships to the CLIs like REA's
  skill, adjusted so it does not tell agents to run `craft-anything-cli setup`.

### 4. The Craft area (owner only)

- A new owner page (working name **Craft**) with a list of rebuilds and a detail view.
  Owner only; not in the user app.
- **Start form:** what to make (request), target (web address, local path, or none),
  stack (optional, default "Builder's choice", choices from Craft Anything's list),
  builder account (Claude accounts; default the owner's default Claude account),
  clean room / deep (default clean room), auto mode (default off; global default in
  settings; one switch for both questions and approvals — owner's decision), rounds
  (Craft Anything's default unless changed). No model picker, no budget. Starting is the owner's
  explicit consent (AgentPier runs the server with `--allow-run`).
- **Detail view:** the four steps (Study → Build → Check → Ready) from status and
  activity, the latest check and similarity, open questions and approvals with their
  answers, the activity log, usage (tokens, cost estimate), buttons to open the result
  (a [preview](../../previews.md) for websites, the files in the file explorer, the
  project), **Pause** (`rebuild_stop`), **Continue / ask for changes** (follow-up
  `rebuild_start` on the same project), switches for auto mode and clean room / deep.
- **Live updates:** the list and detail follow live topics (`docs/architecture.md`,
  Live channel), signalled by the supervisor; no client polling.
- **Questions and approvals** also appear in the owner [inbox](../../inbox.md) and its
  push notifications (a new inbox source and notification type; no Telegram), answered from there or from the detail view; one answer path
  (`project_inbox_answer`).
- Search index (⌘K), German and English catalogs, docs and screenshots as AGENTS.md
  requires.

### 5. Every rebuild is an AgentPier project

- On start AgentPier creates a new folder in the owner's default projects folder, named
  from the request or target (made unique), runs `git init`, and registers it as an
  AgentPier project, following `agentpier_project`
  (`server/features/assistants/agent-projects.js`): never adopt an existing folder,
  roll back only what this call made.
- Craft Anything gets exactly that folder as `project_folder`; nothing is written
  elsewhere.
- Layout: Craft Anything's records at the root, the code in `app/`. AgentPier writes a
  `.gitignore` that keeps `capture/`, `checks/`, `inbox/` and `investigation.cany/` out
  of Git; `app/` and `craft.json` are tracked. AgentPier makes **no commits**: like any
  project, the owner (or a session) commits. (Layout, ignore list and no-commit are
  Claude's calls; the owner did not choose them.)
- Follow-ups go to the same project. The owner can open a normal session in it at any
  time.

### 6. Supervision

- One **supervisor** in the AgentPier server owns the `craft-anything-cli mcp` child
  used for rebuilds (separate from the sessions' MCP server rows), talks MCP over
  stdio, and is the only caller of `rebuild_start`.
- **Account:** the child's environment gets the chosen account's `CLAUDE_CONFIG_DIR`
  (and the matching secure-storage variable AgentPier sets for that account), and a
  `PATH` whose `claude` is AgentPier's managed Claude Code. Builds therefore bill to
  and are recorded under that account. If one child cannot serve two accounts at once,
  the supervisor runs one child per account in use.
- **Process lifetime:** the child and everything it starts run in their own process
  group; when the supervisor stops it (shutdown, restart, update, removal) the whole
  group ends. A build interrupted that way shows as paused and continues with
  `resume` on the owner's **Continue**; nothing restarts on its own.
- **State:** AgentPier keeps the list of rebuilds it started (project id, folder,
  account, options) and reads status, questions, checks and usage from Craft Anything
  (`rebuild_status`, `project_show`, `rebuild_activity_show`) to signal its live
  topics. Craft Anything reports no events, so the supervisor samples a running build;
  the interval and stopping when nothing runs are the builder's call, documented with
  the topic as AGENTS.md requires.
- **Auto mode switch (one switch, owner's decision):** on every start and when toggled, the supervisor sets
  `project_questions_set` (`ask` / `decide`) and the project's approval behaviour.
  Off means every question and every approval Craft Anything would ask about reaches
  the owner.

### 7. Starting from sessions and agents

- **Callers (owner's decision):** the owner's coding sessions and the owner's agents.
  Not pipelines, routines or hooks.
- AgentPier gives them a tool to start a rebuild and one to read its status (for
  sessions through AgentPier's session MCP, for agents through their AgentPier tools).
  A start goes through the supervisor; the rebuild appears in the Craft area and its
  questions reach the owner, not the calling agent.
- **What a caller may set (Claude's call):** request, target and stack only. Account,
  clean room / deep and auto mode always follow the owner's defaults, so no agent can
  start a build that never asks the owner. Whether a start from an agent needs the
  owner's confirmation first is the builder's call within the existing grant model
  (`docs/mcp.md`).

## Constraints

- AGENTS.md applies in full: no new hex colours, components from `docs/ui-guide.md`,
  breakpoints from `web/lib/breakpoints.js`, 600-line limit, i18n parity with
  `npm run i18n:confirm`, live topics instead of polling, search entries, docs for
  every changed behaviour, release notes.
- Craft Anything is early alpha with frequent releases (five in a week). Pin one
  version, raise it deliberately; every tool name and argument above is from 0.5.0 and
  must be re-checked when the pin moves.
- Tests never use the real Claude account or the owner's folders: a fake `claude` on
  `PATH` (as in the spike) and a temporary config dir cover the supervisor end to end.
- Responsible use: Craft Anything's own note (software you own or may examine; no DRM,
  login or anti-cheat bypass) is shown in the dialog, like REA's dual-use note.

## Left to the builder

- Where in the navigation the Craft area sits and its final name (both languages).
- How tool restriction for sessions is done (decision 3).
- One supervisor child for all accounts or one per account (decision 6).
- Sampling interval and the live-topic shape.
- How the taken-over REA components are renamed/migrated without breaking installed
  REA servers (decision 2).
- Splitting into pull requests; a reasonable cut is (a) shared Ghidra/JDK, (b) managed
  install + session MCP, (c) supervisor + projects, (d) Craft area UI, (e) session MCP
  start tool.
