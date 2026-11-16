# Runtime descriptor: agent runtimes register their features, options and UI

Date: 2026-11-16. Status: design, awaiting the owner's approval. Working document;
delete it before the pull request that completes the work (AGENTS.md).

## Intent

AgentPier runs agents on two runtimes, OpenClaw and Hermes Agent, whose abilities
differ. Today every difference is a comparison with a runtime id somewhere in feature
code. The owner finds that tedious and error-prone: a new ability means finding and
extending each of those places, on the server and in the web app, and trying to offer
it on both runtimes.

The owner wants a modular interface instead: **each runtime registers what it offers,
with its options, and the UI adapts**. A feature only one runtime has is added in that
runtime's own module and nowhere else. Nobody has to implement everything twice.

## What exists today

- ADR 0006 gave each runtime adapter a fixed list of 15 capabilities
  (`RUNTIME_CAPABILITIES`, `server/features/assistants/runtimes/agent-runtime.js`),
  each `{ available: true }` or `{ available: false, reason }`. The agent view carries
  them as `runtimeInfo.capabilities`; `web/components/CapabilityGate.jsx` keeps an
  unavailable surface visible, disabled, with the translated reason.
- The list is AgentPier's, not the runtime's, and it is yes or no. Everything a
  runtime does _differently_ or _alone_ is hard-wired:
  - Web, about a dozen comparisons: the wizard's runtime chooser
    (`wizard/StepStart.jsx`, `AgentWizard.jsx`, `wizard-draft.js`,
    `wizard-creation.js`), the shell level "every command" (`shell-level.js`), the
    ChatGPT login a Hermes agent may use and image creation
    (`runtime-capabilities.js` `modelsFor`, `imagesFor`), dreaming
    (`settings/CapabilityGroups.jsx`), whether changed Telegram people restart the
    agent (`TelegramSendersSettings.jsx`), plus Hermes-shaped code without a
    comparison (`settings/memory-pins.js`, `settings/dream-diary.js`,
    `settings/AllowlistPage.jsx`, `settings/skill-list.js`).
  - Web, one runtime-owned group: `hub/RuntimeHermesGroup.jsx` with
    `hermes-runtime.js` and `useHermesRuntime.js` (which polls every 2 s while Hermes
    installs) against `GET/PUT /api/assistant-runtime/hermes`.
  - Server, about 15 comparisons outside `runtimes/`: memory format and limits
    (`memory-entries.js`, `memory-archive.js`, `memory-review.js`, `native-memory.js`,
    `assistant-bootstrap.js`), chat folders (`chat-file-folders.js`), advanced
    settings (`advanced-config.js`), wiring (`application/assistants.js`,
    `application/hermes-wiring.js`), and helpers the port exports that are a runtime
    id in disguise (`runtime-for.js` `ownProcess`, `hermesFleetOf`, `hermesAvailable`,
    the `hermes*` memory re-exports, `registry[id].execAllowlist`).
    Further ones: `own-process-guidance.js` (`memoryKind: "hermes"`),
    `assistant-maintenance.js` (`.id === "openclaw"`), and the default
    `runtime = "openclaw"` in `memory-review-prompt.js` and `memory-review-answer.js`.
  - Server, twelve `hermes-*.js` feature modules outside the adapter (dreams, tool
    guard, home guard, browser upload, generated images, routine approvals, image
    migration), plus `server/features/operations/hermes-backup-paths.js` and the
    routes in `server/http/routes/assistant-hermes.js`. Three of them test
    `runtimeIdOf(agent) !== "hermes"` on entry (`hermes-routine-approvals.js`,
    `hermes-browser-upload.js`, `hermes-tool-guard.js`, the last two as an
    authorization check); `hermes-dreams.js` filters its agents by it.
- Advanced settings (Agents › Runtime › Advanced) are already described as data:
  `advanced-config.js` serves `{ id, type, options, bounds, unit, reloadKind, … }` and
  `web/features/settings/AdvancedSettingRow.jsx` renders any of them. But the list is
  OpenClaw's (`path` is an `openclaw.json` path) and Hermes maps onto it by id
  (`runtimes/hermes/hermes-config/advanced.js`); the row carries a `hermes` field.
- `tests/unit/runtime-port-rules.test.js` already forbids Gateway method names and
  client access outside `runtimes/` (absolute) and adapter imports (with a
  shrink-only allowlist). The same pattern fits here.
- "Manifest" already names each runtime's version pin
  (`runtimes/hermes/hermes-manifest.js`, `runtimes/openclaw/runtime-manifest.js`),
  so the new thing is called the runtime **descriptor**.

## Goals

1. A runtime describes itself in one place: its **descriptor**. Feature code on the
   server and in the web app asks the descriptor; it never compares a runtime id.
2. A difference in _how_ a shared feature behaves is a value the runtime states
   (a **trait**), not a branch in feature code.
3. A feature only one runtime has (a **surface**) is registered by that runtime and
   shows up in the UI at a named place, without edits to the pages around it.
4. A simple option needs no UI work: the runtime describes the field and AgentPier
   renders, validates, stores and compiles it.
5. A test keeps it that way: runtime ids outside the runtime modules fail the build,
   with an allowlist that starts with today's places and may only shrink.

## Non-goals

- Runtimes as external plugins loaded at run time. Descriptors are modules in this
  repository, registered at build time (my call: translations, the UI guide and the
  security review all assume in-repo code).
- A third runtime, or moving an agent between runtimes.
- Turning OpenClaw's host pages into surfaces (my call). OpenClaw stays the built-in
  runtime: its service group, update journal and blockers (`RuntimeServiceGroup`,
  `AssistantRuntimeUpdates`, `RuntimeUpdateBlockers`, `/api/assistant-runtime/updates`)
  and `runtimeFor(null, supervisor)` for the shared host stay as they are. In scope is
  what names a runtime id today; OpenClaw registers traits and its advanced settings,
  and no built surface.
- Slots in the wizard. A new agent starts with each option's default; options are
  changed in its settings.
- The detailed design of the three first consumers (see First consumers). Each gets
  its own short design after a spike against the pinned runtime.
- Redesigning existing pages, or rendering today's hand-built pages (memory, dreams,
  allowlist, Telegram) from field descriptions.
- Feature parity. A runtime may simply not have something.

## Anti-goals

- Settings pages that turn into generic key-value forms. Described fields are for
  options that really are one switch, choice or number.
- Traits that are a runtime id in disguise (`isHermes: true`, `kind: "hermes"`). A
  trait names behaviour: `memory.format: "entries"`.
- A shared feature a runtime lacks disappearing silently. ADR 0006's rule stays:
  visible, disabled, with the reason.
- The comparisons moving into one big `switch (runtime.id)` in a "descriptor helper".

## Constraints

- AGENTS.md: both UI catalogs with matching keys and a confirmed translation lock for
  every text; UI from `docs/ui-guide.md` components only; the ⌘K search index
  (`web/app/search-entries.js`, `web/features/users/user-search-entries.js`) updated
  for every page, tab, settings group or action; server state reaches the browser
  over the live channel, not by polling; files under 600 lines.
- Server and web app ship as one build. No compatibility with an older server's
  `runtimeInfo` shape is needed; `capabilityOf` may keep tolerating a missing view.
- No behaviour change for existing agents in the steps that only move code.
- ADR 0006 stays valid; this refines its `capabilities()` and its step 3
  ("capability-driven UI"). Record the refinement as ADR 0007 when step 1 ships.

## Approaches

1. **Capabilities with values, plus the rule test.** Keep the fixed list; let a
   capability carry values; forbid runtime ids outside `runtimes/`. Removes the
   comparisons, incremental. The UI stays entirely hand-built and a runtime still
   cannot add anything of its own.
2. **Approach 1 plus described settings.** The runtime also describes its option
   fields and the UI renders them, as the advanced settings do today. Texts still
   come from the catalogs.
3. **The runtime describes its whole UI.** Tabs, wizard steps and fields from the
   registration. Most modular; but generic forms are worse than today's pages, and
   most special cases have behaviour a field cannot describe (dreams, memory format,
   moving a ChatGPT login).

**Chosen:** the owner prefers 3, falling back to 2 where forms would get unwieldy.
The design is 3 as the frame with 2's rendering: the runtime registers _all_ of its
own UI as surfaces, and each surface is either **described** (fields, rendered
generically) or **built** (a component in the runtime's web module). Shared pages
stay AgentPier's and read traits.

## Design

### Three kinds of thing a runtime states

| Kind        | Whose vocabulary | Example                                                     | UI                                                                    |
| ----------- | ---------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| **Feature** | AgentPier's      | `routines`, `browser`, `skills`, `channelBots`              | AgentPier's page; unavailable → visible, disabled, reason (unchanged) |
| **Trait**   | AgentPier's      | `shell.levels`, `memory.format`, `channelBots.peopleApply`  | AgentPier's page reads the value                                      |
| **Surface** | the runtime's    | Hermes install/update group; a Hermes-only advanced setting | the runtime's, at a named slot; absent on other runtimes              |

Features are today's capabilities, renamed. Traits hang off a feature. AgentPier's
core declares each feature's trait schema (allowed keys and values) and
`defineAgentRuntime` refuses a descriptor that states an unknown feature, an unknown
trait or a value outside the schema, as it refuses unknown capabilities today. A
runtime that states no value gets the schema's default, which is OpenClaw's behaviour
today.

Traits needed to remove today's comparisons (names are the builder's to refine, the
behaviour is fixed):

| Trait                     | Values                            | OpenClaw      | Hermes        | Replaces                                              |
| ------------------------- | --------------------------------- | ------------- | ------------- | ----------------------------------------------------- |
| `approvals.shellLevels`   | subset of off/approval/every/full | without every | all four      | `everyCommandApproval`, `d.runtime === "hermes"`      |
| `approvals.allowlist`     | `patterns` \| `exactCommands`     | patterns      | exactCommands | `registry[id].execAllowlist`, AllowlistPage           |
| `agentFiles.memoryFormat` | `markdown` \| `entries` (+limits) | markdown      | entries       | `memory-*.js`, `memory-pins.js`                       |
| `agentFiles.dreaming`     | `host` \| `agent`                 | host          | agent         | `CapabilityGroups.jsx`, `hermes-dreams.js` entry test |
| `models.chatgptLogin`     | `any` \| `agentpierHeld`          | any           | agentpierHeld | `modelsFor`, `imagesFor`, `refuseModelChoice`         |
| `channelBots.peopleApply` | `live` \| `restart`               | live          | restart       | `restartsOnPeople`                                    |
| `sessions.chatFolders`    | boolean                           | false         | true          | `keepsChatFolders`                                    |
| `host.process`            | `shared` \| `perAgent`            | shared        | perAgent      | `ownProcess`, `runtimeAccepts`                        |
| `host.install`            | `builtin` \| `optional`           | builtin       | optional      | wizard `hermes` flag, `RuntimeHermesGroup`            |

`advancedSettings`, `everyCommandApproval` and `channelBots` stop being special
entries of the capability list: the first becomes a described surface (below), the
second a trait, the third stays a feature.

### The descriptor

Server half, `server/features/assistants/runtimes/<id>/descriptor.js`:

```js
export const hermesDescriptor = defineRuntimeDescriptor({
  id: "hermes",
  name: "Hermes Agent",
  features: {
    approvals: offers({
      shellLevels: ["off", "approval", "every", "full"],
      allowlist: "exactCommands",
    }),
    agentFiles: offers({ memoryFormat: "entries", dreaming: "agent" }),
    // a feature it lacks: unavailable("reasonId")
  },
  surfaces: [
    { id: "install", slot: "hub.runtime", kind: "built" },
    {
      id: "advanced",
      slot: "hub.runtime.advanced",
      kind: "described",
      scope: "host",
      fields: [/* … */],
    },
  ],
  // resolve, compiler, runOf: what registry[id] holds today
});
```

`runtime-for.js` builds its registry from the descriptors. `runtimeDetails` returns
`{ id, name, version, features, surfaces }`; the agent view keeps carrying it as
`runtimeInfo`. A runtime this AgentPier lacks still shows every feature unavailable
with `runtimeUnknown`.

Web half, `web/features/assistants/runtimes/<id>/index.js`: the components of the
runtime's built surfaces by surface id, the runtime's copy (labels and hints of its
described fields, from the catalogs) and its search entries.
`web/features/assistants/runtimes/index.js` is the only module that names them.

### Surfaces and slots

A slot is a named place on a page AgentPier owns. Start with the slots today's code
needs and add one only with a surface that uses it:

- `hub.runtime`: a group in Agents › Runtime (today `RuntimeHermesGroup`).
- `hub.runtime.advanced`: the runtime's rows in Agents › Runtime › Advanced.
- `agent.capabilities`: a group at the end of an agent's Capabilities tab, for the
  runtime's per-agent options. Further agent tabs get a slot with the first surface
  that belongs there.

`<RuntimeSlot name="hub.runtime" />` renders the surfaces registered there by every
runtime the server lists, in registry and descriptor order; nothing when there are
none. `<RuntimeSlot name="agent.capabilities" assistant={…} />` renders those of the
agent's runtime. A surface states when it shows: `always` (an optional runtime's install group,
as the Hermes group shows today while Hermes is off) or `whileEnabled` (the default;
its advanced rows, as today's Hermes notes show only while Hermes is on).

A **built** surface is the runtime's own component and gets the slot's context (the
host state, `navigate`, the tab's draft where the slot is inside one). It follows
the UI guide like any other screen.

A **described** surface is a list of fields:

```js
{ id: "delegation", type: "toggle" | "select" | "number" | "text",
  options, min, max, step, unit, default,
  apply: "live" | "nextTurn" | "restart" }
```

AgentPier renders it with the guide's rows (`ToggleRow`, `SelectRow`, `NumberRow`;
`AdvancedSettingRow` is the starting point), validates a write on the server against
the same description, and stores it (below). The runtime's compiler receives the
stored values with the desired state and maps them into its own configuration;
`apply` tells AgentPier whether a save needs the restart confirmation it already
has. `scope: "host"` fields are the advanced settings (below); `scope: "agent"`
fields are per-agent options (after that).

Texts never come from the server: every described field has a label and a hint in
both catalogs under the runtime's namespace, and a unit test fails for a field
without one in either language.

### Advanced settings

Two kinds of setting:

- A **shared** setting is AgentPier's: its id, type, options, bounds and default are
  defined once, outside the adapters (today's list, lifted out of
  `openclaw-config/advanced-settings.js`). Each runtime's descriptor states whether it
  takes the setting and how: its own `path`, the translation of the value (Hermes:
  "off" → "none", no "adaptive") and `apply`. The row names the runtimes it reaches,
  as today's row does for Hermes.
- A **runtime's own** setting is defined entirely in its descriptor and shows as a
  row under that runtime's name. This is what is not possible today.

`apply` may be a static value or answered by the adapter at read time: OpenClaw keeps
reading its reload kind and availability from the running Gateway per version
(`liveKinds`, `qualified`), through its config sub-port.

Storage (my call): the existing override store stays as it is, keyed by OpenClaw
path, for the shared settings; no row moves, so an older AgentPier reads them
unchanged. A runtime's own settings go to a new store beside it, keyed by runtime id
and setting id, which an older AgentPier ignores. `advanced-config.js` loses
`hermes()` and `hermesSettings()` and iterates the listed runtimes.

No Hermes-only setting is named yet; step 4 ships the mechanism with the shared
settings moved onto it, covered by a test runtime's own setting, and no visible
change until a runtime registers one.

### Per-agent options

The comparison of both runtimes' native features (2026-11-16) showed that most
differences are not "one runtime lacks it" but "both have it and AgentPier switches
it differently". So, as with advanced settings, there are two kinds:

- A **shared** option is a field of AgentPier's agent model like any other (in the
  runtime-neutral desired state, `agent-desired-state.js`), with a hand-built row on
  AgentPier's page. Each runtime states a feature or trait for it and its compiler
  maps the value. A runtime without it shows the row disabled with the reason.
- A **runtime's own** option is a `scope: "agent"` field of a described surface in
  the `agent.capabilities` slot, or a built surface there when a field cannot
  describe it. Values are stored in the agent's profile under
  `runtimeOptions[runtimeId][fieldId]`, validated against the descriptor, saved with
  the tab's draft like the fields around them, and handed to that runtime's compiler
  with the desired agent.

`runtimeOptions` travel with the profile: backups keep them; a duplicate and a
template keep them for the same runtime and drop them for another; a team member
does not inherit its lead's and starts with the defaults. An option whose field a
later descriptor no longer names is ignored, never an error, so a rollback of
AgentPier or of the runtime starts the agent.

Field types grow with their first user. Besides toggle, select, number and text,
the first consumers need `connection`: one of AgentPier's model connections the
agent's runtime can use (the choice `modelsFor` filters today).

### First consumers

Three features the owner chose from the comparison. They prove the three shapes;
each is delivered after the step it needs, with its own short design and a spike on
a separate AgentPier instance.

| Feature               | Runtime  | Shape                          | What is known                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | -------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Learns its own skills | both     | shared option                  | Hermes: `skill_manage`, background review and curator, on today without a switch. OpenClaw 2026.10.9: Skill Workshop (`skills.workshop.autonomous.mode`), which AgentPier pins to `off` in `runtime-config.js` and locks. Defaults stay as today (my call): off on OpenClaw, on on Hermes. Open: whether OpenClaw's mode can differ per agent. |
| Mixture of Agents     | Hermes   | runtime's own option           | `moa.presets`: reference models advise, the aggregator acts and is billed. Selected as provider `moa`. Open: mapping AgentPier's model connections and its proxy onto reference slots; cost shown to the owner.                                                                                                                                |
| Memory wiki           | OpenClaw | runtime's own option (+ page?) | Bundled plugin `memory-wiki` beside `memory-core`: `wiki_search`, `wiki_get`, vault per agent (`vault.scope: "agent"`), `bridge` mode over the memory plugin. Open: plugin and tool allow-list changes, backups of the vault, whether the owner gets a page to read it (a built surface).                                                      |

### The list of runtimes

`GET /api/assistant-runtimes` answers every runtime this AgentPier ships:
`{ id, name, install: { state, version, error }, features, surfaces }` (a built-in
runtime's install state is `builtin`; its updates stay on their own page), pushed over
a live topic when an install or update changes state. It replaces
`GET /api/assistant-runtime/hermes` for reading, `useHermesRuntime`'s polling, the
hard-coded pair in `StepStart.jsx` and the wizard's `hermes` flag: the wizard offers
the runtimes that are ready and reads the chosen one's traits before the agent
exists. Install, switch and update actions keep their per-runtime routes; the built
`install` surface calls them.

### Server code outside the adapter

- A comparison that picks behaviour reads a trait:
  `traitOf(agent, "agentFiles", "memoryFormat") === "entries"`.
- A comparison that picks an _implementation_ becomes a port method both adapters
  implement (the memory parser and limits: `agentFiles.memory.entries(text)`,
  `.limits()`), so `memory-entries.js` holds no format of its own.
- The twelve `hermes-*.js` modules, `hermes-backup-paths.js` and the Hermes routes
  move into `runtimes/hermes/` and are attached by the descriptor's `wire(services)`
  hook (services, routes, backup paths), which the composition root calls once per
  runtime. Entry tests on the agent's runtime stay, inside the adapter, where naming
  its own id is allowed: the two that are authorization checks
  (`hermes-tool-guard.js`, `hermes-browser-upload.js`) must keep refusing an agent of
  another runtime exactly as today.
- `runtime-for.js` stops exporting `ownProcess`, `hermesFleetOf`, `hermesAvailable`
  and the `hermes*` memory helpers.

### The rule

Extend `tests/unit/runtime-port-rules.test.js` (and its scanner in
`tests/helpers/`) to the web app: outside `server/features/assistants/runtimes/`
and `web/features/assistants/runtimes/`, no source file contains a runtime id as a
string literal next to a comparison, `includes` or object key, imports a runtime's
module, or is named `hermes-*`/`openclaw-*`. The allowlist starts with today's
files and may only shrink; after the last step it holds only the permanent
exceptions, each with its reason. Those are `"openclaw"` as something other than an
agent's runtime: the holder of a login (`model-accounts.js`,
`model-account-move.js`, `mcp-oauth-holders.js`, `ChatgptAccountDetail.jsx`,
`McpOAuth*.jsx`), the consumer of AgentPier's proxy (`proxy-access.js`,
`mcp-changes.js`, `application/assistant-graph.js`), the source of an allowlist
entry (`exec-allowlist.js`) and `browser-upload-staging.js`; plus product copy in
the catalogs. The builder checks each against this description and moves any that
turns out to be a runtime comparison after all.

### Search

`web/app/search-entries.js` and the user app's index collect the search entries of
every runtime's web descriptor for its surfaces, in German and English, shown when
the surface shows (an `always` install group is findable before the runtime is
installed). `tests/unit/search-index.test.js` checks each surface with a group has
one.

## Delivery order

Each step is one pull request without a visible change unless it says so.

1. **Traits.** Features with trait schemas, descriptors for both runtimes,
   `runtimeInfo.features`, `traitOf` on server and web, the rule test with its
   allowlist. Move the web comparisons. ADR 0007.
2. **Runtime list.** `GET /api/assistant-runtimes` with its live topic; wizard and
   Runtime tab read it; the 2 s poll goes.
3. **Slots and built surfaces.** `RuntimeSlot`, the web runtime modules,
   `RuntimeHermesGroup` becomes Hermes's `install` surface; search entries.
4. **Described surfaces.** Field descriptions, generic rendering, the new store,
   validation, compiler input; shared advanced settings lifted out of the OpenClaw
   adapter, each runtime stating its mapping.
5. **Server.** Port methods for memory, `wire(services)`, the `hermes-*.js` modules
   move into the adapter; the allowlist shrinks to its permanent exceptions.

6. **Per-agent options** (after step 4). `runtimeOptions`, the `agent.capabilities`
   slot, the `connection` field type. Ships with **Learns its own skills** as the
   shared option beside it, so the step is visible and used.
7. **Mixture of Agents** on Hermes, then **Memory wiki** on OpenClaw, each from its
   own design.

Steps 5 and 6 do not depend on each other.

## Left to the builder

- Exact names of traits, slots and helper functions; file split within the 600-line
  limit.
- Whether `capabilities` stays as the property name in `runtimeInfo` during step 1
  or is renamed at once.
- The catalog namespace for runtime copy and how the label test finds fields.
- Which further slots a later surface needs.
- Test layout, following the existing contract and rule tests.
