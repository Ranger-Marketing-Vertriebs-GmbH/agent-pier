# Runtime descriptor: runtimes state their traits and register their own UI

---

Status: accepted; step 1 (traits) implemented. Surfaces, described options and the
server-side moves follow.

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
about itself: its id, its product name and its traits (`defineRuntimeDescriptor`).
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

`everyCommandApproval` is no capability any more: it is the `every` entry of
`approvals.shellLevels`.

A **surface** is UI a runtime registers at a named slot of a page AgentPier owns. It
is either _described_ (fields AgentPier renders, validates, stores and hands to the
runtime's compiler) or _built_ (a component in the runtime's web module). Per-agent
options of one runtime are stored in the agent's profile under `runtimeOptions`. An
option both runtimes have is a field of AgentPier's own agent model, mapped by each
compiler. Surfaces are not implemented yet.

### 3. No runtime ids outside the runtime modules

`tests/unit/runtime-id-rules.test.js` fails when product code outside
`server/features/assistants/runtimes/` and `web/features/assistants/runtimes/` holds a
runtime id as a string literal, or a file there is named after a runtime. Its
allowlists start with the places that existed and may only shrink; each group names
the step that empties it. Permanent entries are `"openclaw"` as something other than
an agent's runtime: the holder of a login, the consumer of AgentPier's MCP proxy, the
source of an allowlist entry.

## Delivery order

1. Traits, descriptors, the runtime list, the rule. Done.
2. The runtime list with each runtime's install state over the live channel; the
   wizard's runtime chooser reads it.
3. Slots and built surfaces; the Hermes group of the Runtime tab becomes Hermes's.
4. Described surfaces; advanced settings per runtime.
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
- Until the later steps land, the allowlist of the rule shows what is left.
