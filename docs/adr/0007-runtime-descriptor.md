# Runtime descriptor: runtimes state their traits and register their own UI

---

Status: accepted; steps 1 (traits), 2 (the runtime list with install state), 3
(slots and built surfaces) and 4 (described surfaces, advanced settings per runtime)
implemented. Per-agent options and the server-side moves follow.

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
allowlists start with the places that existed and may only shrink; each group names
the step that empties it. Permanent entries are `"openclaw"` as something other than
an agent's runtime: the holder of a login, the consumer of AgentPier's MCP proxy, the
source of an allowlist entry, and the name of OpenClaw's temporary folder
(`browser-upload-staging.js`).

The same test lists the product files that import a web runtime module: the slot and
the search index, no page.

The rule sees literals and file names. It does not see a helper that hides the
comparison: `ownProcess()` in `runtime-for.js` compares the runtime id inside the
runtime modules and is called from about 14 feature files outside them. Those calls
go with step 5.

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
accepts, is ignored. The runtime's compiler receives its own values by field id,
stored or default, beside the desired state (`runtime-settings.js` `ownSettings`); the
adapter that describes the first field passes them into its compile.

## Delivery order

1. Traits, descriptors, the runtime list, the rule. Done.
2. The runtime list with each runtime's install state over the live channel; the
   wizard's runtime chooser reads it. Done.
3. Slots and built surfaces; the Hermes group of the Runtime tab becomes Hermes's;
   its search entry. Done.
4. Described surfaces; advanced settings per runtime. Done.
5. Server: port methods for memory; Hermes's own services move into its adapter.
6. Per-agent options, with "Learns its own skills" as the first shared option.
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
- Until the later steps land, the allowlist of the rule shows what is left, except
  the comparisons behind helpers such as `ownProcess()`, which it cannot see.
