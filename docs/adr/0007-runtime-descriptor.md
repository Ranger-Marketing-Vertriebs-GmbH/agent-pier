# Runtime descriptor: runtimes state their traits and register their own UI

---

Status: accepted; steps 1 (traits), 2 (the runtime list with install state), 3
(slots and built surfaces), 4 (described surfaces, advanced settings per runtime) and
5 (the server readers, decision 6; a runtime's own services in its adapter, decision 7) implemented. Step 6 is implemented narrowed (decision 8): the first shared per-agent option; per-agent options of one runtime follow with their first consumer.

Date: 2026-11-16

---

## Context

[ADR 0006](0006-assistant-runtime-port.md) put OpenClaw and Hermes Agent behind one
runtime port and gave each adapter a fixed list of capabilities, each available or
unavailable with a reason. That list is AgentPier's, and it is yes or no. Everything a
runtime does _differently_, or has _alone_, became a comparison with a runtime id in
feature code: about a dozen in the web app (the wizard, the "Every command" shell
level, which ChatGPT login an agent may use, dreaming, whether changed Telegram people
restart the agent), about fifteen on the server outside the adapters, a group of the
Runtime tab built for Hermes alone, and a dozen Hermes feature modules beside the
adapter.

The owner finds that tedious and error-prone: a new ability means finding and
extending each of those places, and trying to offer it on both runtimes. The owner
wants each runtime to register what it offers, with its options, and the UI to adapt.

A comparison of both runtimes' native features showed that most differences are not
"one runtime lacks it" but "both have it and AgentPier switches it differently"
(self-learning skills, session search, memory consolidation). Features only one has
exist too (Hermes: Mixture of Agents, a kanban board; OpenClaw: the memory wiki,
device nodes).

## Decision

### 1. Each runtime has a descriptor

`server/features/assistants/runtimes/<id>/descriptor.js` states what the runtime says
about itself: its id, its product name (and `shortName`, what its agents go by in a
sentence: "Hermes agents"), its traits and its surfaces (`defineRuntimeDescriptor`).
The registry of `runtime-for.js` is built from the descriptors.
`runtime-descriptors.js` holds them without importing an adapter, so any module may
read one.

"Manifest" already names each runtime's version pin (`hermes-manifest.json`,
`openclaw/runtime-manifest.js`); the descriptor is something else.

### 2. Three kinds of statement

| Kind        | Whose vocabulary | Example                                                  | UI                                                                   |
| ----------- | ---------------- | -------------------------------------------------------- | -------------------------------------------------------------------- |
| **Feature** | AgentPier's      | `routines`, `browser`, `skills`, `channelBots`           | AgentPier's page; unavailable → visible, disabled, reason (ADR 0006) |
| **Trait**   | AgentPier's      | `approvals.shellLevels`, `agentFiles.memoryFormat`       | AgentPier's page reads the value                                     |
| **Surface** | the runtime's    | Hermes's install and update group; a Hermes-only setting | the runtime's, at a named slot; absent on other runtimes             |

A feature is a capability of ADR 0006. A **trait** says how a runtime behaves within
a feature. AgentPier owns the vocabulary (`runtimes/runtime-traits.js`): each trait
belongs to a capability, names behaviour and never a runtime (`memoryFormat:
"entries"`, not `kind: "hermes"`), lists its allowed values and has a default, which
is OpenClaw's behaviour. A descriptor that states an unknown trait or a refused value
fails when the module loads.

Traits travel beside the capability: `runtimeInfo.capabilities[feature]` is
`{ available, reason?, …traits }`. They are static, so they are known while no host
answers, and a runtime this AgentPier lacks shows the defaults. On the server
`traitOf(agent, feature, trait)` reads them; in the web app
`traitOf(runtimeInfo, feature, trait)` (`web/features/assistants/runtime-traits.js`),
whose defaults a test keeps equal to the server's.

`GET /api/assistant-runtimes` lists every runtime this AgentPier ships as an agent's
`runtimeInfo` shows it, so the wizard knows a runtime's traits before an agent exists.
A runtime with a host per agent answers its traits alone there.

Each entry also carries the runtime's install state and whether a new agent may run
on it now: `install` is `{ kind: "builtin" }` for a runtime whose trait
`host.install` is `builtin`, and `{ kind: "optional", …state }` for an optional one,
with the state of the owner's switch (`enabled`, `installed`, `installing`,
`updating`, `version`, `targetVersion`, `updateAvailable`, `error`, …); `ready` is
true for a built-in runtime and for an optional one that is switched on and
installed. The composition root registers each optional runtime's state by its id
(`services.runtimeInstalls`), so feature code names none. The list is the live topic
`runtimes` (`docs/architecture.md`, Live channel): the wizard's runtime chooser and
the slot of Agents › Runtime that renders Hermes's install group follow it, and
nothing polls an install.

`everyCommandApproval` is no capability any more: it is the `every` entry of
`approvals.shellLevels`.

A **surface** is UI a runtime registers at a named slot of a page AgentPier owns. It
is either _described_ (fields AgentPier renders, validates, stores and hands to the
runtime's compiler) or _built_ (a component in the runtime's web module). Per-agent
options of one runtime are stored in the agent's profile under `runtimeOptions`. An
option both runtimes have is a field of AgentPier's own agent model, mapped by each
compiler. Built surfaces (decision 4) and described surfaces for a runtime's
advanced settings (decision 5) are implemented; per-agent options are not yet.

### 3. No runtime ids outside the runtime modules

`tests/unit/runtime-id-rules.test.js` fails when product code outside
`server/features/assistants/runtimes/` and `web/features/assistants/runtimes/` holds a
runtime id as a string literal, or a file there is named after a runtime. Its
allowlists started with the places that existed and may only shrink; since step 5
no file is named after a runtime, and the literals left are the permanent entries:
`"openclaw"` as something other than
an agent's runtime: the holder of a login, the consumer of AgentPier's MCP proxy, the
source of an allowlist entry, and the name of OpenClaw's temporary folder
(`browser-upload-staging.js`).

The same test lists the product files that import a web runtime module: the slot and
the search index, no page.

A third list covers what literals and file names do not show: every identifier
outside the runtime modules that spells a runtime's name as a word part, in an
import, a call, a member, a key or a declaration (`hermesFleetOf`,
`services.hermesRuntime`, `hermes.state()`, `stripOpenClawRows`). The scanner reads
code without comments, strings and template literals; a regular expression counts, so
a pattern that spells a runtime's folder is found too. Its allowlist holds, each with
its reason, what names OpenClaw as something other than an agent's runtime (the
holder of a login, its temporary folder), formats OpenClaw defines and AgentPier
reads as data (`metadata.openclaw` of a skill, `__openclaw` on a transcript message),
the host backup's knowledge of the built-in runtime's state folder, and the product
name on the built-in runtime's host page.

#### Known limits of the rule

- **The runtime modules are not scanned, the port's public ones included.**
  `runtime-for.js`, `runtime-wiring.js`, `runtime-services.js` and
  `runtime-backup-paths.js` lie in `runtimes/` and name Hermes. A helper there with a
  neutral name can therefore still hide a runtime; only review keeps them to helpers
  that ask a trait, the registry or the agent's runtime.
- An expression inside a template literal, a name built at run time, comments, log
  texts and prose are not read.
- **`ownProcess` stands for "the one runtime with a host per agent".** The trait
  `host.process: "perAgent"` is true of Hermes alone, and several places rely on
  that. They are correct with the two runtimes shipped; with a second per-agent
  runtime each needs a finer trait or a port method:
  - `runtimes/hermes/wiring.js`: Hermes's update journal claims the workspaces of
    every per-agent runtime's agents (`ownProcessUpdateScope`);
  - `server/application/assistants.js`: the start calls `startAll` on every set of
    agent hosts with all agents;
  - `proxy-access.js`: the ChatGPT proxy credential is granted to any own-process
    agent;
  - `exec-approvals.js`, `native-heartbeats.js`, `agent-browsers.js`,
    `dreaming-backups.js`: behaviour that is Hermes's, chosen by `ownProcess`;
  - `runtime-services.js` `part()`: the first runtime that brings a part (tool
    routes aside, which are merged by URL) serves every agent, whatever its runtime.
- The lists of `runtime-wiring.js`, `runtime-services.js` and
  `runtime-backup-paths.js` are kept by hand beside the registry of `runtime-for.js`.
  `tests/unit/runtime-wiring.test.js` fails when a runtime with a host per agent has
  no backup rules, or an adapter has a `wiring.js` or `services.js` its list lacks.

### 4. Slots and built surfaces

A **slot** is a named place on a page AgentPier owns. AgentPier owns the list
(`RUNTIME_SLOTS`, `runtimes/runtime-surfaces.js`, exported from the port) and adds a
slot with the first surface that needs it. Today there are two: `hub.runtime`, a
group of Agents › Runtime, and `hub.runtime.advanced`, the runtime's own rows in
Agents › Runtime › Advanced (decision 5).

A descriptor states its surfaces as `surfaces: [{ id, slot, kind, shows }]`. `kind`
is `built` or `described` (decision 5). `shows` says
when the surface is on screen: `whileEnabled` (the default) while a new agent may run
on the runtime, the list entry's `ready`; `always` also before, as the install group
of an optional runtime must. A missing or repeated id and an unknown slot, kind,
`shows` or key fail when the module loads, like a wrong trait. Hermes registers
`{ id: "install", slot: "hub.runtime", kind: "built", shows: "always" }`; OpenClaw
registers none. The runtime list and an agent's `runtimeInfo` carry `surfaces`; a
runtime this AgentPier lacks has none.

In the web app each runtime with UI of its own has a web module,
`web/features/assistants/runtimes/<id>/index.js`: its web descriptor `{ id, surfaces:
{ [surfaceId]: Component }, search }`. `web/features/assistants/runtimes/index.js`
looks one up by runtime id. `<RuntimeSlot name="hub.runtime" context={…} />`
(`web/features/assistants/RuntimeSlot.jsx`; the selection is `runtime-surfaces.js`)
follows the runtime list and renders, for every runtime in the list's order, each
built surface the server names for that slot that shows, with the component
registered under the surface's id. The component receives `runtime` (its list entry,
so it reads its install state there and looks no runtime up), `context` (what the
page offers, on the Runtime tab `navigate`), `list` (`error`, `refresh` and `written`
of the runtime list, to follow its own actions) and `anchor` (the element id a link
to the slot scrolls to, given to the slot's first surface). The page around the slot
imports nothing of a runtime. A surface the server names without a component renders
nothing and is reported once in development; `tests/unit/runtime-surfaces.test.js`
fails when a descriptor names a built surface the web registry lacks, or the reverse.

The Hermes group of Agents › Runtime is Hermes's `install` surface
(`runtimes/hermes/InstallSurface.jsx`), unchanged for the owner.

A web descriptor's `search` entries (`{ surface, label, aliases }`, one per surface,
read from the catalogs) put its surfaces into the owner's ⌘K index
(`web/features/assistants/runtime-surface-search.js`): an entry is listed while its
surface shows, so the install group is found before Hermes is installed, and it opens
Agents › Runtime at the slot (`section=runtimes`). They are listed a second time
without their components in `runtimes/search.js`, because the search index loads
before any runtime UI and Node's tests load no JSX; the same test keeps both lists
equal. Users never see Agents › Runtime, so their search holds no surface.

### 5. Described surfaces and the advanced settings

A **described** surface is a list of fields instead of a component:
`{ id, slot, kind: "described", scope, fields }`, each field `{ id, type: "toggle" |
"select" | "number" | "text", options?, min?, max?, step?, unit?, default, apply:
"live" | "nextTurn" | "restart" }`. `scope: "host"` is the runtime's advanced settings
for all its agents, at the slot `hub.runtime.advanced`. An unknown type, a select
without options, bounds on anything but a number, a default the field itself refuses
and a field id used twice in one runtime fail when the module loads. AgentPier
renders the fields with the UI guide's rows (`ToggleRow`, `SelectRow`, `NumberRow`,
`TextRow`), validates a write against the same description and stores it. Labels and
hints never come from the server: the runtime's web module registers them from its
catalog namespace (`web/features/assistants/runtimes/fields.js`), and a unit test
fails for a shipped descriptor's field without a label or a hint in either language.
No shipped runtime describes a field yet; a runtime only tests know covers the
mechanism.

The advanced settings for all agents (Agents › Runtime › Advanced) are of two kinds:

- A **shared** setting is AgentPier's: id, group, type, options, range, unit and
  default are defined once, in `runtimes/shared-settings.js`, which names no runtime.
  A runtime takes it when its compiler's `advancedSettings` names the id, with the
  runtime's own key as `path` (an `openclaw.json` path, a Hermes `config.yaml` key
  or process variable), the translation of the value (Hermes: "off" is "none", no
  "adaptive") and how a running host takes a change as `reloadKind` (`hot`, `none`,
  `restart`). Each list is approved for one runtime version.
- A runtime's **own** setting is a described field of its descriptor.

`advanced-config.js` names no runtime. It iterates the registry
(`runtime-for.js` `advancedRuntimes`), where each runtime brings a host port
(`openclaw/openclaw-advanced.js`, `hermes/hermes-advanced.js`): its state (enabled,
running, version, whether that version is approved), optionally what the running host
answers at read time (OpenClaw reads each path's reload kind and its value from the
Gateway, once per version), and what a save does. A save of a shared setting runs
through each taking runtime that writes its host itself (OpenClaw: a live patch, or a
confirmed restart that undoes the stored value when it fails) and then tells every
taking runtime (Hermes applies its agents). A save of a runtime's own setting goes to
that runtime's port (`storeOwn`), which makes the host take it as the field's `apply`
says; a `restart` field asks with the confirmation the shared settings use.

`GET /api/assistant-advanced-settings` answers `{ runtimes, settings }`: per runtime
`{ id, name, shortName, process, enabled, running, version, qualified, agents, own }`
(`own`: its described fields with their stored value, null while the default
applies), and per shared setting its description, the stored `override` and
`runtimes: { [id]: { apply, available, current } }` for each runtime that takes it.
`PUT` takes `{ setting, value }` for a shared setting or `{ runtime, field, value }`
for a runtime's own, each with `confirmRestart`. The page renders from that answer:
"{name} only" and "Restarts {name} agents" take the runtimes' short names and show
while a further runtime is on and has agents, as before.

Storage: the shared settings stay in the override store as they were
(`openclaw_overrides`, keyed by OpenClaw's path), so no row moves and an older
AgentPier reads it unchanged. A runtime's own settings go to a new table beside it,
`runtime_settings`, keyed by runtime id and field id, which an older AgentPier never
reads. A stored value whose field the descriptor no longer names, or no longer
accepts, is ignored.

What is not wired yet: a runtime's own stored values reach no shipped compiler.
`ownSettings` (`runtime-settings.js`: every described field's value by field id,
stored or default) is what a compiler is to receive beside the desired state, but it
has no caller in production; neither OpenClaw's nor Hermes's host port implements
`storeOwn`, so a save of an own setting answers 409 (`advancedSettingUnavailable`).
Only the runtime that tests know exercises the path. This wiring comes with the first
runtime that describes a field: its adapter passes `ownSettings` into its compile and
its host port implements `storeOwn`.

A write's context gives only a runtime on the shared host the restart of the agent
service and its question; a runtime with a host per agent restarts its own hosts, so
a setting of its own never restarts the agent service. The shared settings are listed
and saved only while the default runtime, whose path keys the store, offers advanced
settings.

### 6. Server code outside the adapter asks traits and port methods

A comparison with a runtime id in server feature code is one of three things, and
each has its replacement:

- It **picks behaviour** (does this agent keep notes under `memory/`, does it run on
  a process set of its own): the code reads a trait, `traitOf(agent, feature, trait)`.
- It **picks an implementation** (what an entry of a memory file is, how one is
  removed or appended, which limit a file has): both adapters implement a port
  method. For memory that is `agentFiles.memory` (`runtimes/memory-format.js`,
  `openclaw/openclaw-memory.js`, `hermes/hermes-memory.js`): `entries(content)`,
  `without(content, texts)`, `appended(content, text)`, `limit(name)`,
  `chars(content)` and `pinMarker`. It is pure, so `memoryFor(agent)`
  (`runtime-for.js`) answers the same object without a host, as `compilerFor` does
  for the compiler; a runtime this AgentPier lacks answers the default runtime's
  format, as its traits answer the defaults. Its contract is pinned for every adapter
  in `tests/helpers/runtime-port-memory-contract.js`.
- It **carries a runtime id through feature code** as a parameter: the code carries
  the agent, or the trait value and what the format states, instead.

Moved so far, each off the rule's allowlist:

| File                                                                     | Was                                                 | Is                                                                     |
| ------------------------------------------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------- |
| `memory-entries.js`                                                      | parsed both formats by runtime id                   | `memoryFor(agent).entries` / `.without`                                |
| `memory-archive.js`                                                      | notes allowed, entry appended, limit checked by id  | trait `agentFiles.memoryFormat`; `memory.appended`, `.limit`, `.chars` |
| `memory-review.js`, `memory-review-prompt.js`, `memory-review-answer.js` | a `runtime` parameter, root files only by id        | the agent as parameter; trait `agentFiles.memoryFormat`                |
| `native-memory.js`                                                       | day notes and a file's `limit` by id                | trait `agentFiles.memoryFormat`; `memory.limit`                        |
| `assistant-bootstrap.js`, `own-process-guidance.js`                      | `memoryKind: "hermes"`                              | `memoryFormat` (the trait's value) and `pinMarker` (the format's)      |
| `assistant-maintenance.js`                                               | sessions of the runtime with the id `openclaw`      | sessions of the runtime under maintenance (`runtimeFor(null, …).id`)   |
| `agent-browsers.js`                                                      | the key `hermes` of a browser AgentPier runs itself | the key `own`                                                          |
| `server/application/assistants.js`                                       | starts the fleet when an agent's runtime is Hermes  | when an agent's trait `host.process` is `perAgent`                     |

### 7. A runtime's own services live in its adapter and are wired through the port

Hermes's services lived beside the adapter and were imported by name: its nightly
dreams, the guards behind its team plugin, its browser upload, routine approvals and
generated images, its backup path rules, its routes and its wiring in
`server/application/`. They live in `runtimes/hermes/` now (`dreams/`, `tools/`,
`hermes-backup-paths.js`, `hermes-routes.js`, `wiring.js`), and OpenClaw's MCP
command line in `runtimes/openclaw/`. Three port modules reach them:

- **`runtime-wiring.js`**, for the composition roots. A runtime with services of its
  own has a `<id>/wiring.js` with up to three hooks, each called in registry order:
  - `wire(services, context)`, once per application
    (`wireRuntimes(services, { config })` in `application/services.js`). It makes what
    lives as long as the application and returns `{ services, install, routes,
listening }`. `wireRuntimes` merges that generically: the services onto
    `services` by their names (Hermes: `hermesRuntime`, the owner's switch), `install`
    as `services.runtimeInstalls[id]` (the runtime list's install state), `routes`
    and `listening` into `services.runtimeWiring`, which the agent routes mount
    (`runtimeRouters`) and the server calls once it listens (`startRuntimes`).
  - `agentHosts(supervisor, context)`, once per assistant graph (`wireAgentHosts`):
    the graph is built anew whenever agents are switched on, so the hosts of a
    runtime with a host per agent cannot come from `wire`. Hermes builds its fleet and
    attaches it (`attachAgentHosts`).
  - `applyInputs(connected)`, once per connected graph (`ownProcessWiring`): what an
    apply of one of its agents reads beside the agent's record.

  OpenClaw has no wiring: it is the built-in runtime, whose supervisor the assistant
  graph constructs itself. A rule lets a composition root import the built-in
  runtime's adapter and no other.

- **`runtime-services.js`**, for feature code: what a runtime brings to a feature
  AgentPier shares. `runtimeToolRoutes()` are the team bridge's routes a runtime's own
  plugins call (Hermes's guard, routine approval and browser upload, at their old
  URLs), `agentDreams(options)` and `dreamDiary` the dreams of agents that dream by
  themselves, `generatedImages` the images an agent creates in a home of its own.
- **`runtime-backup-paths.js`**, for host backups: a runtime's rules over paths of
  its private folder (excluded, private, sealed browser profiles, credentials). It
  imports those rules alone, so backup and restore load no adapter.

The parts of `runtime-services.js` and `runtime-backup-paths.js` are not returned by
`wire`: their callers are modules without the application's services (a restore, a
bridge request, a quota check), and `wire` runs only in the server process.

`runtime-for.js` holds each supervisor's agent hosts by runtime id and answers by
the agent's runtime:

| Was                                              | Is                                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `ownProcess(agent)` compared the id              | reads the trait `host.process`                                                                 |
| `attachHermesFleet`, `hermesFleetOf`             | `attachAgentHosts(supervisor, id, hosts)`, `agentHosts(supervisor, agent)`, `agentHostSets`    |
| `hermesAvailable(supervisor)`                    | `runtimeReady(supervisor, agent)`; `assertRuntimeReady` refuses with the runtime's own refusal |
| the fleet's `on("status")` in feature code       | `onAgentHostStatus(supervisor, listener)`                                                      |
| `openClawProfiles` in the wiring                 | `sharedHostAgents(profiles)`                                                                   |
| a Hermes key pattern in `chat-removal.js`        | `ownHostSessionKey(sessionKey)`                                                                |
| `openClawFrameEvent`                             | `sharedHostFrameEvent`                                                                         |
| `hermes*` memory re-exports                      | gone; the dream imports `hermes-config/memory.js` in its adapter                               |
| `openClawUpdateScope`, `hermesUpdateScope`       | `sharedHostUpdateScope`, `ownProcessUpdateScope` (`runtime-update-scope.js`)                   |
| `assistants.hermesDreams`, `config.hermesInputs` | `assistants.agentDreams`, `config.hostInputs`                                                  |

A per-agent runtime's registry entry also tells its session keys (`sessionKey`,
`sessionAgent`, next to `runOf`), which `ownHostSessionKey` and `runtimeForSession`
ask instead of spelling a key format.

The translated refusal `hermesUnavailable` keeps its key and text; the registry entry
of a runtime with a host per agent names its refusal, and feature code raises it
through `assertRuntimeReady`. The two entry checks that are authorization checks
(`tools/hermes-tool-guard.js`, `tools/hermes-browser-upload.js`) refuse an agent of
another or an unknown runtime as before; a test pins that.

Nothing is constructed, started or stopped earlier or later than before: the switch
after the assistant feature, the fleet where the graph built it, the agents' own
hosts after the shared host's start, the fleet's close after the shared host's.
`tests/unit/runtime-wiring.test.js` pins the wiring and the order of the agent
services' start.

### 8. A shared per-agent option: "Learns its own skills"

Step 6 was planned with per-agent options of one runtime (`runtimeOptions` in the
profile, a slot `agent.capabilities`, a `connection` field type). No option needs
them yet, so they are not built; they come with their first consumer. What is built is
the first **shared** option, as decision 2 defines one: a field of AgentPier's own
agent model that each runtime's compiler maps onto its own mechanism.

- **The field.** `skillLearning` (boolean, optional) on the agent profile, through
  validation, the store and the create and update routes. Unset means the runtime's
  default: the effective value is `stored ?? trait` (`skill-learning.js`
  `learnsSkills`), the agent view carries it, and the desired state names it as
  `skills.learning`. An agent from before the field therefore compiles exactly as it
  did, on both runtimes. A task member has no value of its own and follows its lead.
- **Traits** (`skills`): `learnsByDefault` (Hermes `true`), `userAgentsLearn`
  (whether an agent of restricted users may learn; Hermes `true`) and
  `writesWhenAsked` (whether an agent with learning off still writes a skill when
  asked; Hermes `true`), which the settings read for the switch's second sentence.
- **OpenClaw** (`openclaw-config/skill-learning.js`): its review mode is Gateway-wide
  and its per-agent lever is tool policy, so an agent that learns holds
  `skill_workshop` and `skills.workshop.autonomous.mode` is `auto` while at least one
  agent does, else `off`. The compiler port offers `learningTools` and `hostLearns`;
  a live apply moves the entry, the global tool and the mode in one patch.
- **Hermes** (`hermes-config/skills.js`): learning off writes
  `skills.creation_nudge_interval: 0`, on removes the key.
- **Restricted users.** On a runtime whose learned skills bypass the skill lists that
  limit what a user's agent reads (`userAgentsLearn: false`), such an agent never
  learns: the effective value is `false` whatever is stored, so every compile drops
  it; create (also a duplicate and a template's agent) and update refuse "on" with
  409 `USER_AGENT_SKILL_LEARNING`; an assignment removes a stored value; the settings
  show the switch locked with the reason. Users never see the switch.
- **Learned skills on the skills page.** OpenClaw's `skills.status` reports them with
  the source `openclaw-workshop`; its skills sub-port adds the port's `origin:
"local"`, so they are listed as Hermes's self-written skills are.

Not decided by the plan and chosen here: an OpenClaw agent with its own bot for other
people never learns (the review reads its other sessions); the feature code names the
runtime-neutral effective value and asks the compiler port for OpenClaw's tool, so no
shared module names `skill_workshop` as a grant.

## Delivery order

1. Traits, descriptors, the runtime list, the rule. Done.
2. The runtime list with each runtime's install state over the live channel; the
   wizard's runtime chooser reads it. Done.
3. Slots and built surfaces; the Hermes group of the Runtime tab becomes Hermes's;
   its search entry. Done.
4. Described surfaces; advanced settings per runtime. Done.
5. Server: port methods for memory and the readers of a runtime id; Hermes's own
   services in its adapter, wired through the port. Done.
6. "Learns its own skills" as the first shared per-agent option. Done (decision 8).
   Per-agent options of one runtime (`runtimeOptions`, the slot `agent.capabilities`)
   come with their first consumer.
7. Mixture of Agents on Hermes; the memory wiki on OpenClaw.

## Considered options

- **Capabilities with values and the rule, nothing more.** Removes the comparisons,
  but a runtime still cannot add anything of its own and every option needs UI work.
- **The runtime describes its whole UI:** tabs, wizard steps and fields from the
  registration. Most modular, but generic forms are worse than today's pages and most
  special cases have behaviour a field cannot describe (dreams, the memory format,
  moving a ChatGPT login). Chosen instead: the runtime registers all of its own UI,
  each piece described or built; shared pages stay AgentPier's and read traits.
- **Runtimes as plugins loaded at run time:** translations, the UI guide and the
  security review all assume code in this repository.

## Consequences

- A new difference between runtimes is one trait in the schema, one value in a
  descriptor and one read, instead of comparisons in several files.
- The web app's trait defaults duplicate the server's; a test keeps them equal.
- OpenClaw stays the built-in runtime: its host pages (service, updates, blockers) do
  not become surfaces.
- A runtime's web module is listed twice, with and without its components; a test
  keeps the two equal.
- The allowlists of the rule hold the permanent exceptions; a new name of a runtime
  outside the runtime modules fails the build, whether a literal, a file or an
  identifier.
- A part of `runtime-services.js` exists once today (Hermes's). A second runtime
  bringing the same part needs a choice by the agent's runtime there.
