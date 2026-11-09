# Agent cards: implementation plan (AGENTPIER-292)

Design: `docs/superpowers/specs/2026-11-09-agent-views-design.md` (owner-approved 2026-11-09).
Internal name **agent cards** (`agentpier_card`, `agent-cards*`), UI copy "Karte"/"card".

## Builder calls fixed here

- Tool `agentpier_card`, actions `create` (title, blocks), `update` (cardId, title?, blocks),
  `read` (cardId, or none for the chat's cards). Update replaces the blocks; a checklist
  item that keeps its id and omits `checked` keeps the person's tick.
- Blocks: `heading`, `text`, `metrics`, `table` (rows may carry one `action` button),
  `chart` (`line` | `bar`), `checklist`, `status`, `links` (http/https), `actions`.
  Limits: 20 blocks, 50 rows/items, 8 columns/metrics/buttons, 200 chart points,
  32 KB JSON, 30 open cards per chat (the oldest is frozen, kept read-only).
- Storage: `agent_cards` (one row per card, blocks JSON, ticks, placements) and
  `agent_card_notes` (the note each turn carried, to strip from the history), both in the
  agents database beside the pinboard tables.
- Placement: each create/update appends a placement (time + request). The history shows the
  card at its latest placement (`card:<id>:<n>`) and a marker at each earlier one (same id
  as before, so the chat window never reorders). The web collapses a marker directly
  followed by its card. At most 50 placements are kept.
- Live: the card rides the chat's own live feed (`/api/assistant-conversations/:id/stream`,
  `/me` feed for users), signalled by `assistants.changed({conversationId})` on every
  write, tick and press; documented in `docs/architecture.md`.
- Ticks: `POST .../cards/:cardId/check` (owner: `/api/assistant-conversations/:id`, user:
  `/api/me/conversations/:id`), silent. Buttons: `POST .../cards/:cardId/press` records the
  press, then the web sends the visible message through the normal send path.
- Turn note: `sendTurn` appends a short "card state" note (cards the person changed since the
  agent last saw them) to the delivered text, records it, and the history strips it.
- Who may write: own agents and user agents (not team members); the call's chat is the
  turn's, the routine's or the hook's (`AgentShares.turn`); update/read only cards of that
  chat. Telegram gets a text fallback on create only (the turn's/routine's Telegram target).

## Tasks

1. **Schema** `server/features/assistants/agent-card-schema.js`: `cardInput(input, previous)`,
   `CARD_LIMITS`, `cardFallback(card)`; errors `cardError(code, status, ...args)` with
   `CARD_*` codes (server i18n `agent-cards`). Test `tests/unit/agent-card-schema.test.js`.
2. **Store** `agent-card-store.js`: create/update/get/list/check/press/seen/freeze/notes/
   forget. Test `tests/unit/agent-card-store.test.js`.
3. **Service** `agent-cards.js` (`AgentCards`): `invoke`, `check`, `press`, `notesFor`,
   `turnNote`, `noted`, `withoutNotes`. Test `tests/integration/agent-cards.test.js`.
4. **Wiring**: team plugin `card-tool.js` + index + manifest + install list; bridge actions
   (`card` in actions, ownerFileActions, routineActions, hookActions); `toolGrants`,
   `routineTools`, `hookTools`, `nativeTools`; `tool-errors.js` CARD_ codes; audit kind
   `card`; application wiring; chat removal and agent deletion; goldens. Test
   `tests/integration/agent-cards-bridge.test.js`.
5. **History + turn note**: `conversations.js`, `conversation-turns.js`. Test
   `tests/integration/agent-cards-history.test.js`.
6. **Routes** owner + `/me`, owner-content guard. Test `tests/integration/agent-cards-routes.test.js`.
7. **Web**: `web/components/ValueChart.jsx` (+ css, gallery, ui-guide); 
   `web/features/assistants/cards/` (`AgentCard.jsx`, blocks, `card-view.js`, css,
   context); `TranscriptItem`, `AssistantChat`, `UserChat`; i18n `agent-cards`.
   Tests `tests/unit/agent-card-view.test.js`, `tests/browser/agent-cards.spec.js`.
8. **Contracts**: `tests/integration/hermes-agent-cards-contract.test.js` (fake model calls
   `agentpier_card`), OpenClaw `tests/integration/assistant-agent-cards-contract.test.js`
   (pinned Gateway, fixture model calls the tool through the installed plugin).
9. **Docs**: agents.md, architecture.md, assistant-gateway.md, hermes-runtime.md parity row,
   ui-guide.md; README feature line. Delete this plan and the spec before the PR.
