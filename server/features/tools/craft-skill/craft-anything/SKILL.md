---
name: craft-anything
description: Investigate how shipped software works (programs, apps, packages, firmware, web bundles) with evidence-backed answers through the Craft Anything MCP tools, keeping a durable brief, plan, hypotheses, findings and handoff in the project.
metadata:
  version: "2"
---

<!-- Source: https://github.com/storytold/craft-anything (crates/setup/src/skill.md, v0.6.0).
     Licence: MIT OR Apache-2.0, (c) Craft Anything contributors.
     Adapted by AgentPier: the connection section describes AgentPier's managed server. -->

# Craft Anything: evidence-first investigation

Use Craft Anything when an answer depends on something that was _built and shipped_: an executable, a
library, an app bundle, an APK, an Electron app, a WebAssembly module, firmware, a crash dump or a
network capture. If you have the source code and the question is about the source, read the source
instead; that is faster and more direct.

## The tools come from AgentPier

- The `craft-anything` tools are provided by AgentPier's managed MCP server. If they are in your tool
  list, go straight to work.
- Trust the live tool list and its schemas over this file; the server may be newer or older.
- Never use the `craft-anything-cli` commands `setup` or `doctor --fix`, and never edit MCP
  configuration files. AgentPier owns the server entry, its mode and its configuration; changes made
  by hand are overwritten. If the tools are missing or failing to start, tell the user to check the
  Craft Anything card in AgentPier.
- Only a small core toolset is listed at first. Call `list_toolsets` to see the others and
  `enable_toolset` to switch one on (native code, Android, Apple, web, runtime…).
- AgentPier runs Craft Anything in restricted mode. A tool refused with `details.reason`
  `restricted_mode` (running code, frida, adb, rebuilds) cannot be enabled from a session: do not
  look for a way around it. Tell the user which tool you wanted and why; rebuilds are started in
  AgentPier by the user, not from a session.
- In Clean room (the default) nothing inside a target is read: only the tools that work from
  outside are listed, and others are refused with `details.reason` `clean_room`. Tools that look
  inside a target, such as `core_target_open`, are not listed at all in Clean room. Work from
  outside instead: call `list_toolsets` and enable the web, browser or capture toolsets it offers
  with `enable_toolset`. Clean room versus Deep is the owner's switch in AgentPier: "Deep mode for
  sessions" on the Craft Anything card. When a question needs Deep mode, tell the user the owner
  can switch it on there instead of working around it, and do not try to change it with
  `settings_set`.

## Working memory: keep it current

Long investigations outlive any single context window. The project keeps a brief, plan, hypotheses,
findings and a handoff note; use them every time.

1. **Start or resume.** Call `core_investigation_show` first. If there is a handoff, continue from it and
   the plan instead of starting over. Also call `core_session_show` to see what is open.
2. **New question?** Before any analysis call, write the brief with `core_brief_write` (the question, why
   it's being asked, the targets, constraints such as "don't run the program", and what a finished
   answer looks like) and an initial plan with `core_plan_update` (short numbered steps, each
   `todo`/`doing`/`done`/`blocked` with a reason).
3. **After each batch of tool calls:** update the plan's step status. When you form a claim worth
   testing, `core_hypothesis_record` with the prediction that would confirm or refute it. When evidence
   arrives, `core_hypothesis_update` (supported, refuted, abandoned) and attach the evidence ids.
4. **When something is settled:** `core_finding_record` with the statement and at least one evidence id.
   Findings are what reports are built from, never chat text.
5. **At the end of every turn:** `core_handoff_write`: where things stand, what to do next, and traps to
   avoid (dead ends, slow tools, misleading strings). Write it as if a stranger picks this up next.
6. `core_journal_read` shows every earlier tool call and model turn when you need to know what was
   already tried.

## Method

- **Observe, derive, infer, and say which.** Observed facts come straight from the bytes or a
  capture. Derived facts are computed from observations (a control-flow graph, a call graph).
  Inferences are judgment (names, intent, a model's reading). Label each claim accordingly.
- **Cite evidence ids** (`ev_…`) for every claim. A claim with no evidence id is a hypothesis.
- **Absence is not proof.** "No string found" or "no caller found" only covers what was searched.
  State the search boundary and the coverage the tool reported, and record an unknown
  (`core_unknown_add`) for anything that matters but is still open.
- **Predict, then verify.** Before running a tool to test a hypothesis, write down what you expect to
  see. If the result disagrees, update the hypothesis instead of explaining the result away.
- **Summary first, then page.** Large results come back as a summary plus an evidence id. Ask for
  pages (`offset`/`limit`) or the specific item you need instead of everything at once. Never repeat
  an identical call that already succeeded or was rejected.
- **Format-aware, not filename-aware.** Let the parsers tell you what a file is.

## Where to start, by target

This table applies to Deep mode. In Clean room (the default) `core_target_open` is not listed;
start from the toolsets that work from outside (see above), or tell the user the question needs
"Deep mode for sessions" on the Craft Anything card in AgentPier.

| Target                                               | First step                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| Native executable or library (ELF, PE, Mach-O)       | `core_target_open`, then the overview, search and function tools      |
| Electron app, `.asar`, or a JavaScript bundle        | `core_target_open` on the app or archive, then the JavaScript toolset |
| Android APK / DEX                                    | `core_target_open`, then the Android toolset                          |
| .NET assembly                                        | `core_target_open`, then the managed toolset                          |
| WebAssembly, Go, PE resources, firmware, crash dumps | the formats toolset                                                   |
| A live web page or Electron window                   | the browser toolset (observation only)                                |
| Two versions of the same app                         | open both, then the application toolset's comparison tools            |

If the user says "my app" without naming it, ask which one. Never guess with an example file.

## Consent and safety

- Tools that run the target's code or change a connected device are not available in a session
  (`restricted_mode`). If a call returns `consent_required`, explain what it would do and ask;
  never look for a way around it.
- Static analysis never runs the target. Don't claim runtime behaviour from static evidence alone;
  say it is inferred.
- Never put secrets, cookies or personal data into notes, findings or handoffs.

## When something fails

| Error code                           | What to do                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `not_found`                          | Check the path or name; in Deep mode open a target first (`core_target_open`)                                          |
| `feature_missing` / `engine_missing` | Read the remediation; it names the toolset, engine or setting needed. If it needs a change in AgentPier, tell the user |
| `restricted_mode`                    | Not available from a session; tell the user (rebuilds are started in AgentPier)                                        |
| `clean_room`                         | The question needs Deep mode, the owner's switch in AgentPier; tell the user                                           |
| `over_limit`                         | The result was too big to send; page it or read it by evidence id (`evidence://<id>` resource)                         |
| `stale_revision`                     | Re-read with `core_investigation_show`, merge, retry                                                                   |
| `consent_required`                   | Ask the user                                                                                                           |

Before you finish: mark each plan step done or blocked, make sure every conclusion in your answer
matches a recorded finding, list what is still unknown, and write the handoff.
