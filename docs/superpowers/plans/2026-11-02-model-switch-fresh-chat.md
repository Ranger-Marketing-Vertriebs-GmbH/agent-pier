# Model switch: fresh chats and memory review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an agent's model family changes, its chats start fresh without stopping work, deliveries follow the fresh chats, and the owner decides which memory entries holding an earlier model's refusals move to an archive.

**Architecture:** A pure `model-family.js` decides when a switch is a family change. A `model-switch.js` module, called from the owner's `update()` and the lead's `MemberEdits`, swaps chats through an extended `main-chat-swap.js` that records a successor, and `successorOf` makes every late delivery land in the fresh chat. After the swap a one-shot runtime method reviews memory without history; findings become an owner-only card (own store, route, inbox type), and the owner's decision moves entries into an AgentPier-side archive.

**Tech Stack:** Node.js ES modules, `node:sqlite`, Express, React/JSX, `node:test`, Playwright; OpenClaw 2026.10.9 and Hermes v0.22.5 behind the runtime port.

**Spec:** `docs/superpowers/specs/2026-11-02-model-switch-fresh-chat-design.md`

## Global Constraints

- Nothing outside `server/features/assistants/runtimes/` talks to a runtime; `tests/unit/runtime-port-rules.test.js` stays green unchanged.
- Source and test files ≤ 600 lines (`npm run check:structure`). `assistant-service.js` is at 599, `assistant-workflows.js` 598, `AssistantChat.jsx` 585, `audit-schema.js` 547: new logic goes into new modules, call sites stay one line.
- UI only from `docs/ui-guide.md` primitives (`Switch`, `ListCard`/`ListRow`, existing card classes); no new hex colours, no font below 11px, no bespoke dialogs.
- Every UI string in `web/lib/i18n/de/` and `en/` with matching keys and arguments; `npm run i18n:confirm -- <catalogs>` and commit the updated `translation-lock.json`. Backend messages in `server/lib/i18n/`.
- No memory entry text in logs or the audit log (counts and file names only).
- New owner routes classified in `server/http/owner-content-routes.js` (`tests/integration/owner-content-classification.test.js`).
- Never cancel work, end members or touch other agents in a model switch (anti-goal). Never archive without the owner's decision.
- Commits: `feat:`/`fix:`/`chore:` prefix, English, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests never use real sessions or the default tmux server; integration tests use `tests/helpers/user-chats.js` (`chatFixture`, `fakeGateway`).

## Review Focus

1. **A delivery arrives after two switches in a row** (chat A → B → C): it must land in C, not in archived B. → `successorOf` follows chains; test in Task 3.
2. **The owner archives an entry that changed meanwhile** (agent edited `MEMORY.md` between review and Apply): nothing is overwritten; that entry is reported as changed and skipped. → hash/verbatim check in Task 8.
3. **A shared agent's user** never sees the review card, the archive or another person's chat hint. → owner-only tests in Tasks 5 and 9.
4. **The review model refuses or returns junk** (Grok's malformed JSON in the spike): one retry, then a notice; the switch stays. → Task 6.
5. **A lead switches a member while that member's turn runs**: the swap waits, the running turn's result reaches the lead, the next turn runs in the fresh chat. → Task 4b.

---

### Task 0: Edit day notes on the memory page (AGENTPIER-353, prerequisite)

**Files:**

- Modify: `server/features/assistants/native-memory.js` (add `writeNote`), `server/http/routes/assistant-capabilities.js:14-29`
- Modify: `web/features/assistants/settings/MemoryPage.jsx`, `web/features/assistants/assistant-api.js:13-23`
- Test: `tests/integration/native-memory-notes-write.test.js`, `tests/browser/assistant-native-capabilities.spec.js`

**Interfaces:**

- Produces: `NativeMemory.writeNote(id, { name, content, expectedHash }) -> { name, hash }` (name must match `noteName`, not `memory/lead/…`, not `memory/.dreams/…`, not `DREAMS.md`; 409 `conflict` when the file's hash differs; writes via the workspace path like `remove()`, atomic temp+rename). Also `NativeMemory.writeNoteNow(...)` without `admit` for callers already in admission.

- [ ] **Step 1:** Write tests `writes a day note against its hash`, `refuses a stale hash with conflict`, `refuses the lead mirror, the corpus and the diary`, `keeps a user's own agent read only` (owner route vs `/me/...` route 404).
- [ ] **Step 2:** Run `node --test tests/integration/native-memory-notes-write.test.js` → FAIL (`writeNote is not a function`).
- [ ] **Step 3:** Implement `writeNote`/`writeNoteNow`; route `PUT /assistants/:id/memory/notes` (body `{ name, content, expectedHash }`), classified as `"agent"` content.
- [ ] **Step 4:** Tests PASS.
- [ ] **Step 5:** MemoryPage: notes are editable when `!locked && !diary`; save through the existing SaveBar step with `expectedHash`; delete via existing remove with a `ConfirmDialog`. Browser test `edits and deletes a day note` in English.
- [ ] **Step 6:** Update `docs/agents.md` "### Memory" (day notes editable); i18n confirm; commit `feat: edit and delete an agent's day notes on the memory page`.

### Task 1: Model family and switch preview

**Files:**

- Create: `server/features/assistants/model-family.js`
- Modify: `server/http/routes/assistants.js` (preview route), `server/http/owner-content-routes.js`
- Test: `tests/unit/model-family.test.js`, `tests/integration/assistant-model-switch-preview.test.js`

**Interfaces:**

- Produces: `modelFamily(model, connections) -> string` and `familyChanged(from, to, connections) -> boolean` where `model = { connectionId, modelId }`; `connections.get(id).providerId` is `"openrouter"`/`"endpoint"`.
- Produces: `GET /api/assistants/:id/model-switch?connectionId=&modelId=` → `{ familyChanged: boolean, freshChatsDefault: boolean }` (owner only, metadata route).

Rules (spec): `openclaw:` connection → `"openai"`; OpenRouter → prefix of `modelId` before `/` (`x-ai/grok-4.7` → `"x-ai"`); endpoint → known prefix of `modelId` if it has one (`openai/`, `anthropic/`, `x-ai/`, `google/`, `deepseek/`, `mistralai/`, `qwen/`, `z-ai/`, `moonshotai/`, `meta-llama/`), else `` `unknown:${connectionId}` ``. `freshChatsDefault = familyChanged`.

- [ ] **Step 1:** Tests: `ChatGPT and openai/ over OpenRouter are one family`, `grok and gpt over OpenRouter differ`, `an endpoint model without prefix is its connection's own family`, `same model is unchanged`.
- [ ] **Step 2:** Run `node --test tests/unit/model-family.test.js` → FAIL.
- [ ] **Step 3:** Implement; route reads `assistants.store.getAssistant(id).model` (effective model for temporary members: `effectiveModel` from `team-presentation.js:70`) and `assistants.models.connections`.
- [ ] **Step 4:** Unit + preview integration tests PASS (owner 200, user 404).
- [ ] **Step 5:** Commit `feat: tell a family change apart when an agent's model changes`.

### Task 2: Notes that name the switch and a redirect

**Files:**

- Modify: `server/features/assistants/memory-notes.js:7-48`
- Modify: `web/features/assistants/TranscriptItem.jsx:75-78`, `web/features/assistants/AgentEventArea.jsx:183`, `web/lib/i18n/{de,en}/assistant-memory-notes.js`
- Test: `tests/unit/memory-notes.test.js` (extend or create), `tests/browser/assistant-memory-notes.spec.js`

**Interfaces:**

- Produces: `MemoryNotes.record({ key, conversationId, reason, details? })`; `details` is `{ from: string, to: string }` (display names) for `"model-switched"`, absent otherwise; `forConversation` returns it as `details`.
- New reasons: `"model-switched"` (fresh chat after a switch), `"redirected"` (a delivery that started in the previous chat).
- Copy: `memoryNoteCopy.reasons["model-switched"]` is a function `(from, to) => string` (en: `` `The model changed from ${from} to ${to}. This chat starts fresh; memory, files and settings stay.` ``), `reasons.redirected` en: `"This result was started in the previous chat."`. German pairs in the same change.

- [ ] **Step 1:** Tests: `keeps the switch's model names`, `refuses details on other reasons`; browser: `shows the model switch note with both models`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; renderers call the reason when it is a function with `m.details.from, m.details.to`.
- [ ] **Step 4:** PASS; i18n confirm `assistant-memory-notes`; commit `feat: note a model switch and a redirected result in the chat`.

### Task 3: Swap with successor and redirected deliveries

**Files:**

- Modify: `server/features/assistants/main-chat-swap.js:21-112`
- Create: `server/features/assistants/chat-successor.js`
- Modify: `server/features/assistants/conversation-turns.js:41-82`, `server/features/assistants/team-results.js:23-31,112-149`, `server/features/assistants/lead-requests.js:548-583`, `server/features/assistants/lead-request-delivery.js:45-55`
- Test: `tests/integration/assistant-chat-successor.test.js`

**Interfaces:**

- Changes: `freshMainChat(service, conversation, onCommit, options?)`, `freshMemberChat(service, member, onCommit, options?)` with `options = { reason = "main-restarted", details, successor = false, main = true }`. In the swap transaction, when `successor`, write `{ successorId: next.id }` on the archived chat; `main` is the new chat's `main` (model switch passes the old chat's `main`). Restart callers pass nothing: behaviour unchanged (late follow-ups still dropped).
- Produces: `successorOf(store, conversationId) -> conversation` (follows `successorId` until an unarchived chat; returns the input chat when none; bounded to 20 hops); `redirectedTo(store, conversationId) -> string|null` (the live successor's id if the chat is archived with a successor).
- `sendTurn`: before `refuseClosedChat`, `const target = redirectedTo(...)`; when set, send into `target` and record note `{ key: "redirected:<clientRequestId>", conversationId: target, reason: "redirected" }`. `team-results.chatRemoved` and `lead-requests.deliveryTarget` resolve through `successorOf` first. `LeadRequests.reply` (~548) reads the reply from the attempt's own conversation id, not `teams.member(...).conversationId`.

- [ ] **Step 1:** Tests: `a member result after a switch lands in the fresh main chat with a redirected note`, `a lead-request answer follows the successor`, `an SSH follow-up follows the successor` (via `sendTurn`), `two switches in a row deliver to the newest chat`, `restart main chat still drops late follow-ups` (no successor), `lead request reply reads the chat its run ran in`.
- [ ] **Step 2:** Run `node --test tests/integration/assistant-chat-successor.test.js` → FAIL.
- [ ] **Step 3:** Implement as above; existing restart tests unchanged.
- [ ] **Step 4:** Run new test and `node --test tests/integration/assistant-main-chat-restart*.test.js` → PASS.
- [ ] **Step 5:** Commit `feat: let late results follow a chat that a model switch replaced`.

### Task 4a: Owner switch starts fresh chats

**Files:**

- Create: `server/features/assistants/model-switch.js`
- Modify: `server/features/assistants/assistant-service.js:302-434` (one call inside admission after `updateAssistant`, one after it; pull `freshChats` out of `input` with the other control keys at 303)
- Modify: `server/http/routes/assistants.js:156-168` (pass `freshChats` through `input`, it is already in `patch`)
- Test: `tests/integration/assistant-model-switch.test.js`

**Interfaces:**

- Consumes: `familyChanged` (Task 1), `freshMainChat`/`freshMemberChat` with options (Task 3), `moveChannels`, `resyncDeliveries`, `mainConversation` (`routine-targets.js:16`), `MemoryNotes` details (Task 2).
- Produces: `planSwitch(service, before, after, { freshChats }) -> { agents: string[], fresh: boolean } | null` (pure: `before`/`after` are assistant records; includes following temporary members = `listAssistants()` with `parentAssistantId === id && temporaryMember(a) && !a.ownModel`, compared via `effectiveModel`); `swapNow(service, plan) -> { chats: [{ assistantId, userId, from, to }], deferred: string[] }` (caller holds admission; swaps every person's main chat of each lead-level agent, `freshMemberChat` for member agents, defers chats that are not free); `afterSwitch(service, plan, result) -> Promise<void>` (outside admission: `resyncDeliveries` per agent, start memory review — Task 6 hook, no-op until then).
- Produces: `chatFree(service, conversationId) -> boolean` = no `ledger.pending()` attempt in it, no `queued.get`, not in `workflows.store.awaiting()`, not `longChats.running`. (Not `owingConversations`, not `teamChats` — spec "When a chat is free to swap".)
- Swap options: `{ reason: "model-switched", details: { from, to }, successor: true, main: old.main }`.
- `update()` return gets `freshChats: { chats, deferred }` when a swap ran.

Note: `update()` already refuses with 409 while any turn of the agent is pending (`assistant-service.js:346-357`), so on the owner path only a queued message, an awaiting approval or a running summary can defer a chat; deferral uses Task 4b.

- [ ] **Step 1:** Tests: `a family switch gives every person a fresh main chat and moves Telegram and routines`, `it cancels no work and leaves members and other agents alone`, `freshChats false keeps the chats`, `a same-family switch keeps the chats unless asked`, `following temporary members get fresh chats with the lead`, `the owner switching a member swaps the member's chat only`, `the fresh chat carries the model-switched note`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `model-switch.js`; `update()` calls `planSwitch` before saving and `swapNow` after `updateAssistant` inside admission, `afterSwitch` after `admit` returns (both branches, incl. the Gateway-restart branch at 413-434).
- [ ] **Step 4:** PASS, plus `node --test tests/integration/assistant-*.test.js` green.
- [ ] **Step 5:** Commit `feat: start fresh chats when an agent moves to another model family`.

### Task 4b: Lead switch and deferred swaps

**Files:**

- Create: `server/features/assistants/deferred-swaps.js`
- Modify: `server/features/assistants/member-edits.js:132-250`, `server/features/assistants/team-plugin/index.js:241-256`, `server/features/assistants/assistant-service.js:146` (one line in `pollReconcile`)
- Test: `tests/integration/assistant-member-model-fresh-chat.test.js`

**Interfaces:**

- Produces: `DeferredSwaps({ service })` with `add(conversationId, swapOptions)`, `tick() -> Promise<void>` (for each held chat: when `chatFree`, take admission and swap; drop when archived or gone; give up after 24 h with a console error), persisted in a table `assistant_deferred_swaps (conversation_id TEXT PRIMARY KEY, body TEXT)` so a restart keeps it. Called from `pollReconcile` beside `queuedDispatch.pollQueued`.
- `MemberEdits.update`: `exact` lists get `"freshChat"`; default from `familyChanged`; after the team transaction, `planSwitch` + `swapNow` in admission (member chats not free → `DeferredSwaps.add`).
- Tool result adds `freshChat: "started" | "waits_for_turn" | "off"` and, when a review runs, `memoryReview: "waits_for_owner"`. Schema: `freshChat: { type: "boolean", description: "Start the member in a fresh chat (default: when the model family changes)." }`; tool description gets one sentence on it. Hermes reuses `definitions`.
- The member-update note payload and history entry get `freshChat: boolean`.

- [ ] **Step 1:** Tests: `a lead's family switch gives the member a fresh chat`, `freshChat false keeps it`, `a running member turn finishes in the old chat and the swap follows`, `a deferred swap survives a service restart`, `the tool result names the fresh chat and the waiting review`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS, plus `tests/integration/assistant-member-model*.test.js` green.
- [ ] **Step 5:** Commit `feat: start a member in a fresh chat when its lead moves it to another model family`.

### Task 5: Hint in older chats

**Files:**

- Create: `server/features/assistants/model-hints.js`
- Modify: `server/features/assistants/conversation-turns.js:108` (record family), `server/features/assistants/conversations.js:302-305,389` (history flag), `server/http/routes/assistant-chats.js:100`, `server/http/routes/me-chats.js:49`, `server/http/owner-content-routes.js:35`, route-access list
- Modify: `web/features/assistants/AgentRunState.jsx:180-201`, `web/features/assistants/useLongChat.js` (sibling hook `useModelHint.js`), i18n `agent-chats`
- Test: `tests/integration/assistant-model-hint.test.js`, `tests/browser/model-hint.spec.js`

**Interfaces:**

- At each sent turn: `store.updateConversation(id, { family: modelFamily(effectiveModel) })` (Task 1).
- Produces: `ModelHints(db)` with `shown(conversation, currentFamily, personId) -> boolean` (true when `conversation.family` is set, differs from `currentFamily`, the chat is not main, and this person has not dismissed it for that pair) and `dismiss(conversationId, personId, fromFamily, toFamily)`; table `assistant_model_hint_dismissals`.
- History payload: `modelHint: boolean`. Routes `POST /assistant-conversations/:id/model-hint-dismissal` and `/me/conversations/:id/model-hint-dismissal`.
- Copy (en): `"This chat began with another model. Its history can affect the answers."`, buttons `"New chat"`, `"Dismiss"`.

- [ ] **Step 1:** Tests: `an older chat shows the hint after a family switch`, `main chats never show it`, `dismissal is per person`, `a user never sees the owner's dismissal state`; browser `shows the hint and starts a new chat` (English).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** i18n confirm; commit `feat: hint that an older chat began with another model`.

### Task 6: One-shot memory review through the runtime port

**Files:**

- Modify: `server/features/assistants/runtimes/agent-runtime.js:78` (port doc), `runtimes/openclaw/openclaw-sessions.js:136`, `team-plugin/chat-title.js` (sibling `team-plugin/memory-review.js`), `team-plugin/index.js:333`, `runtimes/hermes/hermes-sessions.js:460`
- Create: `server/features/assistants/memory-review.js`, `server/features/assistants/memory-review-answer.js`, `server/features/assistants/memory-review-prompt.js`
- Test: `tests/unit/memory-review-answer.test.js`, `tests/integration/assistant-memory-review.test.js`

**Interfaces:**

- Port: `sessions.reviewMemory({ agentId, instructions, input }) -> { text }`. OpenClaw: Gateway method `agentpier.memoryReview` registered like `registerChatTitle`, `api.runtime.llm.complete({ agentId, systemPrompt: instructions, messages: [{ role: "user", content: input }], purpose: "memory-review", maxTokens: 4000, execution: { mode: "isolated-agent-runtime", timeoutMs: 120000 } })`, no tools, same reasoning step-down. Hermes: `llm.oneshot { task: "memory_review", instructions, input, max_tokens: 4000 }`.
- **First step of this task:** check in the pinned Hermes source whether `llm.oneshot` runs on the agent's own model; if it uses an auxiliary model, use the agent's model explicitly (Hermes option) or record why not in `docs/hermes-runtime.md`.
- `memory-review-prompt.js` exports `reviewInstructions` (the spike's task text from `scratchpad/spike/review.mjs`, English, kinds `model-limit | owner-rule | fact`, recommendation `archive | keep`) and `reviewInput(files) -> string` (`=== <file>\n<content>` blocks).
- `memory-review-answer.js`: `parseReview(text, files) -> { entries: [{ file, entry, kind, recommendation }], dropped: number }`; extracts the first JSON array, tolerates one unescaped-quote failure by returning `null` (caller retries once); keeps only entries whose `entry` occurs verbatim as one entry of `file` (`memoryEntries`, Task 7).
- `MemoryReview({ service })` with `run(assistantId) -> { status: "found" | "none" | "failed", entries }`: reads files (OpenClaw: `MEMORY.md`, `USER.md`, notes per `noteName` minus `memory/lead/`, `DREAMS.md`, `memory/.dreams/`; Hermes: `MEMORY.md`, `USER.md`), calls the port, retries once on `null`, never writes. Hooked into `afterSwitch` (Task 4a) per agent of the plan; results go to Task 8.

- [ ] **Step 1:** Unit tests with the spike's answers as fixtures: `keeps verbatim matches`, `drops an entry that is not in the file`, `returns null on malformed JSON`, `classifies an owner rule under a Limits heading as kept` (fixture). Integration: `a switch reviews memory without chat history` (fake gateway records `agentpier.memoryReview` call with only memory text), `a refusal or two malformed answers end as failed`.
- [ ] **Step 2–4:** FAIL → implement → PASS; `tests/unit/runtime-port-rules.test.js` PASS.
- [ ] **Step 5:** Commit `feat: review an agent's memory with its new model after a model switch`.

### Task 7: Memory entries and the archive

**Files:**

- Create: `server/features/assistants/memory-entries.js`, `server/features/assistants/memory-archive.js`, `server/features/audit/audit-memory-archive-details.js`
- Modify: `server/features/audit/audit-vocabulary.js:84`, `server/features/audit/audit-schema.js:22,523`, `server/http/routes/assistant-capabilities.js`, `server/http/owner-content-routes.js`
- Test: `tests/unit/memory-entries.test.js`, `tests/integration/assistant-memory-archive.test.js`, `tests/unit/audit-memory-archive-details.test.js`

**Interfaces:**

- `memoryEntries(runtime, file, content) -> [{ text, start, end }]`: OpenClaw = one list item (with its continuation lines) or one paragraph line; headings are not entries. Hermes = one `§`-delimited block (`entryDelimiter` from `runtimes/hermes/hermes-config/memory.js`). `withoutEntries(runtime, file, content, texts) -> string`.
- `MemoryArchive(db)` table `assistant_memory_archive (id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, body TEXT NOT NULL)`; body `{ file, text, archivedAt, switch: { from, to }, reviewId }`. Methods `list(assistantId)`, `archive(assistantId, entries, meta)`, `restore(assistantId, id)`.
- `archiveEntries(service, assistantId, entries, meta) -> { archived: number, changed: string[] }`: per file read with hash, `withoutEntries`, write with `expectedHash` (`NativeMemory.write` for root files, `writeNoteNow` from Task 0 for notes); an entry no longer present is reported in `changed` and skipped. Then remove verbatim matches from `memory/.dreams/` files (**first step:** inspect the pinned OpenClaw corpus format in a spike instance workspace; if it is not line text, skip the corpus and say so in `docs/agents.md`).
- `restoreEntry(service, assistantId, archiveId)`: appends the text to its file (`\n- ` for OpenClaw list items, `§` block for Hermes; Hermes respects `memoryLimits`, 409 `tooLarge` otherwise).
- Routes: `GET /assistants/:id/memory/archive`, `POST /assistants/:id/memory/archive/:entryId/restore` (owner `"agent"` content).
- Audit: `assistant.memory-archived` / `assistant.memory-restored`, details `{ count, files: string[] }` only.

- [ ] **Step 1:** Tests: `splits list items, paragraphs and Hermes blocks`, `archives an entry and restores it`, `skips an entry the agent changed meanwhile`, `writes no entry text into the audit`, `a user cannot read the archive`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: archive and restore memory entries of an agent`.

### Task 8: Owner card for the review

**Files:**

- Create: `server/features/assistants/memory-reviews.js` (store + decide), `server/http/routes/assistant-memory-reviews.js`
- Modify: `server/features/inbox/inbox-items.js:7,16,192`, `server/features/inbox/inbox-sources.js:173`, `server/http/owner-content-routes.js`
- Create: `web/features/assistants/MemoryReviewCard.jsx`; Modify: `web/features/assistants/AssistantChatActions.jsx:7`, `web/features/inbox/InboxDetail.jsx:25`, `web/features/inbox/InboxSourceDetails.jsx`, i18n `assistants`/`inbox`
- Test: `tests/integration/assistant-memory-reviews.test.js`, `tests/browser/memory-review.spec.js`, extend `tests/browser/inbox.spec.js`

**Interfaces:**

- `MemoryReviews(db)` table `assistant_memory_reviews (id TEXT PRIMARY KEY, body TEXT NOT NULL)`; body `{ id, switchId, createdAt, decidedAt?, conversationId, agents: [{ assistantId, entries: [{ file, entry, kind, recommendation }] }], revision }`. One review per switch; a new switch for the same agents replaces an undecided one.
- `conversationId` = owner's fresh main chat of the switched agent, or for a member the owner's main chat of its lead (`mainConversation(store, leadId, null)`).
- `decide(id, { revision, choices: { [entryKey]: "archive" | "keep" } })` → calls `archiveEntries` per agent, writes `assistant.answered` via `decideAudited` so inbox history works, returns `{ archived, kept, changed }`. Owner only (`refuseUserAgent`), never exposed through `team-plugin` definitions or `status()`.
- `MemoryReview.run` (Task 6) with `status: "found"` → create review; `"failed"` → owner notification "memory could not be reviewed" with a link to the memory page (existing notifications service).
- Routes: `GET /assistant-memory-reviews`, `POST /assistant-memory-reviews/:id/decision` (owner content).
- Inbox: type `"memory-review"`, tab `"agents"`.
- Card: per entry a row with file name and text and two choices (default `archive` for `model-limit`), **Apply**; per-item local state as in `HookProposalCard.jsx:70`. Mounted beside `TeamApprovals` in the conversation it belongs to.

- [ ] **Step 1:** Tests: `a review with findings shows one card in the chat and the inbox`, `Apply archives the chosen entries and keeps the rest`, `a lead never sees the card`, `a user of a shared agent never sees it`, `a second switch replaces an undecided card`, `a failed review sends a notice`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Memory page shows the archive (read only, **Restore** per entry, immediate action) — browser test `restores an archived entry`.
- [ ] **Step 6:** i18n confirm; commit `feat: let the owner archive an earlier model's refusals after a model switch`.

### Task 9: Owner UI for the switch and prevention text

**Files:**

- Modify: `web/features/assistants/settings/ProfileFields.jsx:63-66`, `web/features/assistants/settings/agent-settings-fields.js:267-283`, `web/features/assistants/assistant-api.js` (preview call), i18n `assistant-settings`
- Modify: `server/features/assistants/assistant-bootstrap.js:65-66`, `server/features/assistants/memory-step.js:11`
- Test: `tests/browser/assistant-settings-save.spec.js` (extend), `tests/unit/assistant-bootstrap*.test.js` (extend)

**Interfaces:**

- When the drafted model differs from `draft.base`, fetch the preview (Task 1) and show `Switch` **Start fresh chats** (default `freshChatsDefault`) with one line (en): `"New main chats for everyone using this agent; the old ones stay readable. Nothing running stops."`; `profilePatch` sends `freshChats`.
- Prevention line appended after `assistant-bootstrap.js:66` (en, exact): `"- Do not record your own refusals or limits you set yourself as rules or notes; record the owner's rules, decisions and facts."`; the same sentence appended to `memoryStepText`, and to the guidance Hermes agents get (`own-process-guidance.js:33`; Hermes sees only the read-only memory line today, and its memory tool writes `MEMORY.md`/`USER.md`).

- [ ] **Step 1:** Tests: browser `offers fresh chats on a family switch and sends the choice`, `defaults off for the same family`; unit `bootstrap tells the agent not to store its own refusals`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** i18n confirm; commit `feat: choose fresh chats when changing an agent's model`.

### Task 10: Docs, qualification, cleanup

**Files:**

- Modify: `docs/agents.md` (347 Restart, 431 Identity, 559 Memory, 866/960 team model changes), `docs/assistant-gateway.md` (1156, 1510/1521, 2805), `docs/inbox.md` (18, 44), `docs/hermes-runtime.md`, `README.md`/`README.de.md` if they mention model changes
- Delete: `docs/superpowers/specs/2026-11-02-model-switch-fresh-chat-design.md`, this plan

- [ ] **Step 1:** Update the docs listed; keep heading anchors.
- [ ] **Step 2:** `npm run check` → PASS.
- [ ] **Step 3:** Real-model qualification on a throwaway instance (the spike bench, port 4391, built from this branch): Grok refuses → owner switch to GPT with fresh chats → same probes answer in the fresh main chat; a memory step had written "Grenzen" → card lists them → Apply → next fresh chat answers; record the result in the PR description.
- [ ] **Step 4:** Delete spec and plan; commit `chore: document fresh chats and memory review on model switches`; open the PR (one PR including Task 0), close AGENTPIER-353 with it.
