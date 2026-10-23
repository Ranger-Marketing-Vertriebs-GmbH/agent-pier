# Lead agents edit permanent members and choose member models

Tickets: AGENTPIER-192 (edit permanent members), AGENTPIER-193 (member models).
One branch, `feat/lead-member-models`, 192 first.

## Intent

The owner builds teams with a lead agent (example: "Studio Lead – Hälmchen" with the
permanent members Head Writer and YouTube & Audience Strategist). Two gaps came up in
practice:

1. The lead wrote a new team handbook but could not update the stored instructions of
   its permanent members. `agentpier_team_member_update` only reaches temporary task
   members (`reachableMember()` in `server/features/assistants/member-reach.js`
   rejects `lifetime === "permanent"`). The lead now repeats the new frame in every
   task.
2. Every member runs on the lead's model (temporary members follow it,
   `effectiveModel()` in `team-presentation.js`; permanent members freeze the lead's
   model at promotion). The owner wants each member on the model that fits its work,
   and wants to work that out in conversation with the lead: the lead looks up which
   models the owner's configured accounts offer (OpenRouter, ChatGPT accounts
   through OpenClaw, custom endpoints), proposes, and assigns.

## Decisions by the owner

- The lead may change a permanent member's instructions **on its own**, without a
  prior confirmation by the owner. The owner is informed of every change.
- The lead may assign models **on its own**, e.g. when a member does not cope well
  with its model or a newer model appears.
- **No limits** on accounts or price. When the lead knows the cost of a model, it
  must say it clearly (e.g. "about 5× as expensive as before"); when not, it says the
  price is unknown.

## Goals

### A. Edit permanent members (192)

- `agentpier_team_member_update` also accepts the lead's own, non-archived permanent
  members (`kind === "member"`, `parentAssistantId === lead.id`, `lifetime ===
  "permanent"`, no `archivedAt`), regardless of phase or open conversation.
- Same fields and semantics as for task members (name, role, assignment,
  extraInstructions, whole instructions), same guardrails: member log entry with the
  replaced instructions readable for the owner (last 5), settled note in the member's
  and the lead's chat, audit entry naming fields only.
- No owner-turn requirement and no dependency on team usage; edits apply from the
  member's next turn, including the owner's own chats with it.
- Only the edit predicate changes. `grant` and lead requests keep `reachableMember()`
  unchanged (permanent members already have their own share and request paths).

### B. Member models (193)

1. **Read the model list** — new team tool action (suggested name
   `agentpier_team_models`): all models the lead could assign, across the owner's
   configured and usable model sources (`AssistantModels.listCapabilities()`: OpenClaw
   accounts, OpenRouter connections with a key, endpoint connections). Each entry:
   connection id and name, provider, model id, label, context and output tokens,
   reasoning and image input where known, and price per million input/output tokens
   where known. Optional text filter and a result limit, because OpenRouter alone
   lists hundreds of models. Also returns which model the lead and each of its
   members currently run on.
2. **Prices** — OpenRouter's catalog response already carries `pricing.prompt` and
   `pricing.completion` (USD per token); `normalizeOpenRouter()` in
   `server/features/providers/catalog-normalization.js` drops them today. Keep them
   (normalized to USD per million tokens). Other providers report no price; the list
   says "unknown", never an estimate.
3. **Assign a model**:
   - `member_update` gets an optional `model: { connectionId, modelId }` for the
     lead's own permanent members and reachable task members.
   - `propose` gets an optional `model` per member for new task members.
   - Validation: the model must resolve through `AssistantModels.resolve()` (usable
     connection, valid id) — the same check the owner's agent editor applies.
   - A temporary member with an assigned model stops following the lead's model
     (`effectiveModel()`); without one it keeps following, as today.
4. **Transparency** — the member log entry, the chat notes and the audit name the old
   and the new model. The tool descriptions tell the lead to state known costs and the
   change in cost, and to say when the price is unknown.
5. **Owner overview** — the member's settings keep showing its model; the "model
   changed since it took it over" hint (`memberOverrides()`) must not mark a lead's
   assignment as an owner override (same idea as `leadInstructions` for
   instructions).

## Calls made during the design (builder check)

- **Model sources:** exactly what `listCapabilities()` covers today: ChatGPT accounts
  (OpenClaw), OpenRouter connections with a key, endpoint connections. No new Claude
  account integration.
- **Owner vs. lead on models:** like instructions, the lead may overwrite a model the
  owner picked; the owner sees it and can change it back. The owner may now also set
  the model of a temporary member in its settings (today refused with
  `memberModelFollowsLead`), so every lead assignment can be undone; a "Follow the
  lead's model" option restores the old behaviour. A lead's assignment does not count
  as an owner override in `memberOverrides()`.
- **Unusable assigned model:** turns fail visibly with the usual provider error, as
  for any agent whose model stopped working. No silent fallback to the lead's model.
- **Where the owner is told:** see "Owner notification" below.

## Owner notification

Owner's decision: the existing channels are enough for now; push and inbox are a later,
cross-cutting topic.

- A settled note in the lead's conversation in which the tool ran (also a routine's
  conversation), naming the member, the edited fields and, for a model change, old
  and new model.
- The same note in the member's task chat when it has one (`member.conversationId`);
  a permanent member without one gets no chat note.
- The member's history (`grantLog`, team card and member settings) always records the
  change, with the replaced instructions readable for the owner.
- An audit entry naming the fields (and the models), never instruction text.

## Non-goals

- No price or account limits, no budget tracking (team spend budgets are
  AGENTPIER-171).
- No automatic model scouting; the lead re-reads the list when asked or from a
  routine.
- No changes to how the owner picks models in the agent editor.
- No new grants or shares for permanent members through `grant`.

## Anti-goals

- A lead must never see or receive credentials; it only names a connection id and a
  model id.
- A lead must never edit or re-model members of another lead, archived members, or
  the owner's own non-member agents.
- Every lead change must stay visible to the owner; silent changes are a failure even
  if they work.

## Constraints

- German and English UI texts for every new note and label, with `i18n:confirm`.
- Tool descriptions and server behavior covered by unit and integration tests; the
  team contract tests list the new tool action.
- Update `docs/agents.md` (teams section, member settings) and any README passage
  that lists lead team tools.

## Left to the builder

- Exact tool action name and result shape of the model list.
- Where the lead's assigned model is stored for temporary members (member record vs.
  assistant record) and how `effectiveModel()` reads it.
- How the price is shown in the owner's model picker, if at all (optional).
