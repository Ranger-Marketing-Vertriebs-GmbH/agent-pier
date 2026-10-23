# Lead-edited permanent members and member models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A lead agent can edit its permanent members (AGENTPIER-192) and look up and assign models for its members from the owner's configured model sources (AGENTPIER-193).

**Architecture:** Widen the edit predicate for `member_update`; add an "own model" marker so a temporary member can stop following its lead; add a `models` team tool backed by `AssistantModels` and the provider catalog (with OpenRouter prices); extend `member_update` and `propose` with an optional `model`; surface every change in notes, member history and audit.

**Tech Stack:** Node.js ESM, Express, OpenClaw team plugin, React/JSX, node:test, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-23-lead-member-models-design.md` (read it first).

All paths are relative to the worktree `.worktrees/feat-lead-member-models` (branch `feat/lead-member-models`).

## Global Constraints

- The lead acts on its own: no owner-turn requirement, no team-usage dependency, no price or account limits.
- A lead never sees credentials; it names `{ connectionId, modelId }` only.
- Only the lead's own, non-archived members; never another lead's members or non-member agents.
- Every change is visible: note in the lead's chat, note in the member's task chat when `member.conversationId` exists, member `grantLog` entry, audit entry (fields and models only, never instruction text).
- Unusable assigned model: the turn fails with the usual provider error; no silent fallback to the lead's model.
- Unknown prices are reported as unknown (`null`), never estimated.
- `member_update` and `models` stay out of `routineActions` (team-bridge.js); routines cannot edit members today and this change does not add that.
- Every UI text change: DE and EN with matching keys/arguments, `npm run i18n:confirm -- <catalog>` and commit `translation-lock.json`. UI uses `docs/ui-guide.md` components only.
- Files checked by `check:structure` stay ≤ 600 lines; split a helper module rather than exceed it.
- Commits: `feat:`/`fix:`/`chore:` prefixes, English, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A lead edits a permanent member while the owner is chatting with it → the next owner turn runs with the new instructions/model, no conflict error. (Task 1, Task 5 tests.)
2. `updateAssistant` on a temporary member persists the lead's effective model (`assistant-store.js` L168/L192) → a later unrelated update must not turn "follows lead" into an own model, and must not drop an assigned model. (Task 3 test.)
3. A lead assigns a model whose connection is unusable (OpenRouter without key, signed-out ChatGPT account, unlisted endpoint model) → refused with a stable error code, nothing stored. (Task 5 test.)
4. OpenRouter catalog row with missing, non-numeric or negative `pricing` → price `null`, model still listed. (Task 2 test.)
5. A lead that is itself a member, or a member trying `agentpier_team_models` / `member_update` → refused as today. (Task 4 test.)

---

### Task 1: Leads edit their permanent members (192)

**Files:**
- Modify: `server/features/assistants/member-reach.js` (add `editableMember`)
- Modify: `server/features/assistants/member-edits.js:152` (use `editableMember`)
- Modify: `server/features/assistants/team-plugin/index.js:189-203` (`member_update` description)
- Modify: `web/features/assistants/settings/MemberGroup.jsx` (member history for permanent members)
- Modify: `web/lib/i18n/{en,de}/assistant-member-grants.js` only if a new label is needed
- Test: `tests/integration/assistant-member-edits.test.js`, `tests/browser/assistant-member-grants.spec.js`

**Interfaces:**
- Produces: `editableMember(member, leadId): boolean` in `member-reach.js` — true when `reachableMember(member, leadId)` or (`kind === "member"`, `parentAssistantId === leadId`, `lifetime === "permanent"`, no `archivedAt`). `grant` and lead requests keep using `reachableMember`.

- [ ] **Step 1: Write the failing tests** in `tests/integration/assistant-member-edits.test.js`:
  - Flip the last assertion of "edits are refused for a member that is not the lead's or no longer reachable" (L187–189): a permanent member is no longer refused; an archived permanent member still is (`teamGrantMemberEnded`, 409).
  - New test "a lead re-briefs its permanent member; the owner's next chat runs with it": promote via `f.teams.promote(member.id, member.revision)`, call `update({ instructions: "New handbook" })`, assert `status === "updated"`, `f.agent().instructions === "New handbook"`, `grantLog.at(-1)` has `by: "lead"`, `edited: ["instructions"]` and a `replaced` id readable with `replacedInstructions`, and the lead's chat got a `member_update` note.
  - New test "a permanent member without a task chat still gets a history entry": clear `conversationId` on the member record, update `role`, assert one note (the lead's) and the log entry.
- [ ] **Step 2: Run** `node --test tests/integration/assistant-member-edits.test.js` — Expected: the new and flipped tests FAIL.
- [ ] **Step 3: Implement** `editableMember` and use it in `MemberEdits.updateNow`. Update the `member_update` tool description: "one of your own members: a task member (…) or a permanent member (not archived)… Takes effect from the member's next turn, also in the owner's chats with a permanent member."
- [ ] **Step 4: Member history for permanent members** in `MemberGroup.jsx`: show the member's `grantLog` (reuse `logText()` from `web/features/assistants/member-grants.js` and `ReplacedInstructions.jsx`, the same way `GrantedCapabilities.jsx` L74–89 does) when the member is permanent. Add a browser test in `assistant-member-grants.spec.js`: a permanent member with a lead edit in its log shows the entry and "previous instructions" in its Profile tab.
- [ ] **Step 5: Run** `node --test tests/integration/assistant-member-edits.test.js tests/unit/assistant-member-model.test.js` and `npx playwright test tests/browser/assistant-member-grants.spec.js` — Expected: PASS.
- [ ] **Step 6: Commit** `feat: let leads update the instructions of their permanent members`

### Task 2: OpenRouter prices in the provider catalog

**Files:**
- Modify: `server/features/providers/catalog-normalization.js:20-50`
- Test: `tests/property/providers-catalog.test.js`

**Interfaces:**
- Produces: OpenRouter catalog rows gain `pricing: { inputPerMTok: number|null, outputPerMTok: number|null }` (USD per million tokens, from `model.pricing.prompt` / `model.pricing.completion` × 1 000 000, rounded to 6 decimals). Other providers' rows have no `pricing` key.

- [ ] **Step 1: Write failing tests** in `tests/property/providers-catalog.test.js`: `pricing: { prompt: "0.000003", completion: "0.000015" }` → `{ inputPerMTok: 3, outputPerMTok: 15 }`; missing pricing, `"-1"`, `"abc"` and negative values → `null` for that side, row still present; property: `inputPerMTok` is `null` or a finite number ≥ 0.
- [ ] **Step 2: Run** `node --test tests/property/providers-catalog.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** a `perMillion(value): number|null` helper in `catalog-normalization.js` and set `pricing` in `normalizeOpenRouter`. Cached `provider-catalogs.json` is re-normalised on load, so no migration.
- [ ] **Step 4: Run** the property test plus `tests/unit/assistant-models.test.js` and `tests/matrix/codex-router-context.test.js` — Expected: PASS (update exact-shape assertions that list row keys).
- [ ] **Step 5: Commit** `feat: keep OpenRouter prices in the provider catalog`

### Task 3: Own models for temporary members and owner control

**Files:**
- Modify: `server/features/assistants/team-presentation.js:45-68` (`memberOverrides`, `effectiveModel`)
- Modify: `server/features/assistants/assistant-service.js:274-325` (owner update)
- Modify: `server/features/assistants/assistant-schema.js` / `assistant-validation.js` if the assistant record schema lists fields (add `ownModel`)
- Modify: `web/features/assistants/settings/agent-settings-fields.js:171-179`, `ProfileFields.jsx:52-75`, `ProfileTab.jsx`
- Modify: `web/lib/i18n/{en,de}/assistant-team.js`, `server/lib/i18n/{en,de}/assistants.js` (remove `memberModelFollowsLead` if unused)
- Test: `tests/unit/assistant-member-model.test.js`, `tests/integration/assistant-member-model.test.js`, `tests/unit/agent-settings-fields.test.js`, `tests/browser/assistant-member-model.spec.js`

**Interfaces:**
- Produces: assistant record field `ownModel: true` (absent = follows lead). `effectiveModel(assistant, lead)` returns `assistant.model` when `assistant.ownModel === true`, else today's behaviour.
- Produces: member record field `leadModel: { connectionId, modelId }` — the model the lead last assigned; `memberOverrides(member, assistant)` compares `assistant.model` against `member.leadModel ?? member.snapshot.model`, and reports `model` for temporary members too when `ownModel` is set.
- Produces: owner update input `followLead: true` (temporary members only) clears `ownModel`; a `model` patch on a temporary member sets `ownModel: true` instead of throwing `memberModelFollowsLead`.

- [ ] **Step 1: Write failing tests:**
  - unit: "effectiveModel keeps a temporary member's own model" (`ownModel: true` → own model, not lead's).
  - unit: "a lead-assigned model is not an owner override" (`leadModel` equals current model → `overrides.model === false`; owner changes it → `true`).
  - integration: replace "the agents list shows a task member's effective model and refuses editing it" (L103) with "the owner sets and resets a task member's model": `update(id, { model: other })` → stored with `ownModel: true`, list shows `other`; lead model change does not affect it; `update(id, { followLead: true })` → follows lead again.
  - integration (Review Focus 2): an unrelated owner update (`name`) of a following temporary member leaves `ownModel` unset and the member still follows a later lead model change.
- [ ] **Step 2: Run** `node --test tests/unit/assistant-member-model.test.js tests/integration/assistant-member-model.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the server side. `followLead` is only valid for temporary members; for others refuse with `invalid`.
- [ ] **Step 4: UI.** For a temporary member, `ProfileFields.jsx` shows the regular `AssistantModelFields` plus a "Follow the lead's model" checkbox/switch from the existing components; checked = today's read-only block. `profilePatch` sends `followLead: true` or `model`. New copy in `assistant-team.js` (en/de), e.g. `followLeadModelChoice: "Follow the lead's model"`. Update `agent-settings-fields.test.js` and `assistant-member-model.spec.js` (L81 test becomes "a task member's profile follows the lead's model until the owner picks one").
- [ ] **Step 5: Run** the four test files above and `npm run i18n:confirm -- assistant-team assistants` — Expected: PASS, lock files updated.
- [ ] **Step 6: Commit** `feat: let a temporary member run on its own model`

### Task 4: `agentpier_team_models` — the lead reads the available models

**Files:**
- Create: `server/features/assistants/member-models.js` (list + assignment helpers, used by Tasks 4–6)
- Modify: `team-plugin/index.js` (`definitions.models`), `team-plugin/openclaw.plugin.json` (`contracts.tools`), `team-bridge.js` (`actions`), `team-service.js` (method `models`), `native-capabilities.js` (`delegationTools`), `runtime-config.js` (`teamTools`)
- Test: create `tests/unit/assistant-member-models.test.js`; update tool lists in `tests/unit/assistant-team-runtime-config.test.js`, `tests/unit/openclaw-config-characterization.test.js` (two tests), `tests/unit/openclaw-web-tools-config.test.js` (`nativeAllow`), `tests/integration/assistant-config.test.js` (L280–300)

**Interfaces:**
- Produces: `listMemberModels({ models, catalog, lead, members, query, limit }): { models: Entry[], total, current: { lead, members: [{ memberId, name, model }] } }` in `member-models.js`, where `Entry = { connectionId, connection, provider, modelId, label, contextTokens|null, outputTokens|null, reasoning|null, imageInput|null, pricing: { inputPerMTok, outputPerMTok } | null }`. Sources: `models.listCapabilities()` entries with `available === true` — ChatGPT accounts (`models` rows), endpoint connections (`models` rows), OpenRouter connections (rows from `catalog.list({ providerId: "openrouter" })`, with `pricing`). `query` filters case-insensitively on modelId/label/connection name; `limit` default 50, max 200; sorted by connection then label.
- Produces: `TeamService.models(inv, input)` with input `{ query?: string(≤100), limit?: integer 1–200 }`, `exact`-checked; lead-only through `team-bridge` `valid()` as today.
- Tool description must say: "Prices are USD per million input/output tokens where known; null means unknown — say so, never estimate. When you assign a model, tell the owner its known cost and how it compares to the member's previous model."

- [ ] **Step 1: Write failing tests** in `tests/unit/assistant-member-models.test.js`: entries from all three sources with prices only on OpenRouter; unavailable connections (OpenRouter without key, signed-out account) are omitted; `query` filter; `limit` cap and `total`; `current` names the lead's and each own member's effective model. Update the four exact tool-list tests to include `agentpier_team_models`.
- [ ] **Step 2: Run** the new and updated tests — Expected: FAIL.
- [ ] **Step 3: Implement** `member-models.js` and register the action in all six places listed under Files.
- [ ] **Step 4: Run** `node --test tests/unit/assistant-member-models.test.js tests/unit/assistant-team-runtime-config.test.js tests/unit/openclaw-config-characterization.test.js tests/unit/openclaw-web-tools-config.test.js tests/integration/assistant-config.test.js` — Expected: PASS. Add a bridge test (Review Focus 5): a member calling `models` is refused.
- [ ] **Step 5: Commit** `feat: let a lead list the models it can give its members`

### Task 5: Assign a model with `member_update`

**Files:**
- Modify: `server/features/assistants/member-edits.js` (accept `model`), `member-models.js` (`validateMemberModel`)
- Modify: `team-plugin/index.js` (`member_update` schema + description)
- Modify: `server/features/assistants/member-grant-notes.js:84-96` (pass `model: { from, to }`)
- Modify: `web/features/assistants/MemberGrantNote.jsx`, `web/features/assistants/member-grants.js` (`fieldLabels`, `logText`)
- Modify: `web/lib/i18n/{en,de}/assistant-member-grants.js` (`fields.model`, a model-change note/log text)
- Modify: `server/features/assistants/tool-errors.js` if a new error key is added
- Test: `tests/integration/assistant-member-edits.test.js`, `tests/browser/assistant-member-grants.spec.js`

**Interfaces:**
- Consumes: `editableMember` (Task 1), `ownModel` / `leadModel` (Task 3).
- Produces: `validateMemberModel(models, { connectionId, modelId }): Promise<{ connectionId, modelId, display: { connection, model } }>` in `member-models.js` — calls `models.resolve()` and releases the lease; refuses (`assistantProblem("provider")` or `invalid`) when unresolvable, including an endpoint model not in its list.
- Produces: `member_update` input `model: { connectionId: string(≤200), modelId: string(≤256) }`. On change: `updateAssistant(..., { model, ownModel: true for temporary })`, member record `leadModel = model`, `grantLog` entry `edited` includes `"model"` and `model: { from: display, to: display }`, audit `details.models: { from, to }` (ids only), note payload `model: { from, to }` (labels). Same model again → `unchanged`.

- [ ] **Step 1: Write failing tests:** "a lead moves its permanent member to another model; the next turn runs on it" (assert stored model, `leadModel`, `memberOverrides(...).model === false`, log entry, note with from/to); "a lead gives a task member its own model; a later lead model change leaves it"; Review Focus 3: unusable connection → rejected, nothing stored, no note; "the same model again is unchanged".
- [ ] **Step 2: Run** `node --test tests/integration/assistant-member-edits.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.** `update()` awaits `validateMemberModel` before calling `updateNow` (which stays synchronous inside the transaction). Text fields and `model` may be combined in one call.
- [ ] **Step 4: Web.** Note text e.g. EN `"{lead} moved {member} from {from} to {to}."` / DE `"{lead} hat {member} von {from} auf {to} umgestellt."` (match the existing `note.updated` argument style); log text likewise. Browser test: the note and the history entry show both model labels. Run `npm run i18n:confirm -- assistant-member-grants`.
- [ ] **Step 5: Run** the integration and browser tests — Expected: PASS.
- [ ] **Step 6: Commit** `feat: let a lead assign a model to its member`

### Task 6: Model per member in `propose`

**Files:**
- Modify: `team-plugin/index.js` (`propose` member item schema + description), `team-service.js:266-297`, `team-store.js:264-292` (`memberKeys`, drafts) and `:431-471` (`reserve`), `assistant-store.js:70-93` (`reserveMember`)
- Test: `tests/unit/assistant-team-plugin-install.test.js:66`, `tests/integration/` team propose tests (the file that covers `TeamService.propose`; find with `grep -l "teams.propose" tests/integration`)

**Interfaces:**
- Consumes: `validateMemberModel` (Task 5), `ownModel` / `leadModel` (Task 3).
- Produces: optional `model: { connectionId, modelId }` per member in `propose`. `TeamService.propose` validates each before `store.propose`; the draft keeps `{ connectionId, modelId }` (part of the fingerprint); `reserve` creates the member with that model, `ownModel: true`, and `leadModel` on the member record. Proposal approval cards show the model when set (check the proposal note rendering; add the label in DE/EN if it lists member fields).

- [ ] **Step 1: Write failing tests:** a proposal with a model for one member and none for another → the first runs on its model with `ownModel`, the second follows the lead; an unusable model rejects the whole proposal before anything is stored; schema test expects `model` in the member item.
- [ ] **Step 2: Run** them — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests — Expected: PASS.
- [ ] **Step 5: Commit** `feat: let a lead pick a model per new team member`

### Task 7: Docs and full check

**Files:**
- Modify: `docs/agents.md` (L58–63 profile model hint, L258–268 member models, L319–325 lead edits: permanent members, models tool, owner reset), `docs/assistant-gateway.md` (L853–866 tool list, L1864–1933 promotions and lead edits)
- Delete: `docs/superpowers/specs/2026-10-23-lead-member-models-design.md`, this plan

- [ ] **Step 1:** Update the docs to the shipped behaviour (English, keep anchors). README.md/README.de.md: checked, no lead tool details there — no change unless a team bullet becomes wrong.
- [ ] **Step 2: Run** `npm run check` and `npm test` — Expected: PASS. Run `npx playwright test tests/browser/assistant-member-model.spec.js tests/browser/assistant-member-grants.spec.js` — Expected: PASS.
- [ ] **Step 3:** Delete the spec and this plan; commit `chore: document lead member edits and member models`.
