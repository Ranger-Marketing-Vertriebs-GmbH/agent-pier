# Hermes memory: more room and dreaming

Tickets: AGENTPIER-363 (more room), AGENTPIER-362 (dreaming). Designed together with the
owner on 2026-11-08.

## Intent

Memory is what makes an agent; the owner's words. Hermes agents have memory
(`MEMORY.md` for the agent's notes, `USER.md` for what it knows about the owner), but
only 2,200 and 1,375 characters of it, and no dreaming. The owner finds that too little
room. They want agents to **keep more, but consolidated**: more room, and a nightly pass
that keeps that room tidy instead of letting it fill with stale or duplicate entries.

The one failure the owner named: **dreaming deleting something they explicitly told the
agent.** That must be impossible, enforced by AgentPier, not just asked of the model.

## Goals

1. Hermes agents remember several times as much as today.
2. The existing dreaming switch (**Agents › Runtime › Dreaming**: on/off, hour, time zone)
   also makes Hermes agents dream every night.
3. A Hermes dream consolidates both memory files: takes in lasting facts from the day's
   chats, merges duplicates, replaces what became outdated, and leaves headroom.
4. Entries the owner explicitly asked to keep are protected: dreaming never removes,
   rewrites or merges them, and AgentPier rejects a night that does.
5. The owner can see what each night changed and undo a bad night.

## Non-goals

- Rebuilding OpenClaw's dreaming internals for Hermes (`memory/dreaming/light|rem|deep`
  notes, `memory/.dreams/` corpus, recall store). Hermes keeps its two files; the diary
  is the trace.
- Changing how OpenClaw agents dream (see "Open for later").
- Cross-chat recall / transcript search for Hermes beyond what the dream reads.
- A per-agent memory size setting. One larger fixed size for all Hermes agents.

## Anti-goals

- Dreaming silently losing an owner-requested fact. A rejected night is fine; a lost
  protected entry is not.
- Memory that is bigger but fills up with noise, so the agent again cannot write.
- A night's rewrite that cannot be undone.

## Decisions (owner)

- **Keep more, consolidated** over keeping chats cheap. The owner accepts that every new
  chat carries the larger memory in its prompt.
- **Protected entries:** whatever the owner explicitly tells the agent to remember
  ("merk dir…", "vergiss nicht…") is stored as protected. **This holds for every
  person the agent talks to:** the owner, a user of a shared agent and the user of
  their own agent; any of them can protect an entry by asking, and any of them can
  have a protected entry replaced by telling the agent something newer. The owner can
  also pin or unpin any entry on the memory page (on a user's own agent only where the
  owner may already edit its memory).
- **Dreaming keeps protected entries word for word.** AgentPier compares before and
  after each night; if a protected entry is missing or changed, the whole night is
  discarded, the files restored, and the diary says the night was discarded and why.
- **The agent may replace a protected entry in a chat** when the owner tells it
  something newer that contradicts it (e.g. "I drink tea now, not coffee"). Only
  dreaming is bound; the agent's own chat turns are not.

## Design (proposed in conversation, owner agreed to the direction)

### More room

- Raise the compiled Hermes limits (`memory.memory_char_limit`,
  `memory.user_char_limit`, today `memoryLimits` in
  `server/features/assistants/runtimes/hermes/hermes-config/memory.js`) to about
  **10,000** characters for `MEMORY.md` and **5,000** for `USER.md`.
- Existing Hermes agents get the new limits with the update (next compile/restart).
- The memory page's size display, the owner's edit check (`memoryTooLarge`) and
  **Restore** from the archive follow the new limits automatically, since they read the
  same constant.

### Protected entries

- A protected entry is a normal Hermes memory entry whose text starts with a fixed
  marker the agent and AgentPier both recognise (my call: `📌 ` at the start of the
  entry). It stays inside Hermes's own format (entries separated by `\n§\n`), so
  Hermes's memory tool, the limits and the memory page keep working. The marker counts
  toward the limit.
- The agent's instructions (compiled `SOUL.md`) tell it: when the owner explicitly asks
  it to remember something, write the entry with the marker; when the owner later says
  something that contradicts a protected entry, replace that entry (keeping the
  marker on the new one).
- The memory page shows protected entries with a pin and lets the owner pin and unpin
  any entry in both files (adding or removing the marker through the existing
  hash-checked file write).

### Dreaming for Hermes agents

- **Switch:** the existing global setting (`DreamingSettings`, `dreaming.sqlite`)
  applies to Hermes agents too. The settings copy and docs stop saying dreaming is
  OpenClaw's. The rule "while dreaming is on, **Remember information** stays on for
  every permanent agent" covers Hermes agents.
- **Schedule:** once a night at the owner's dreaming hour in the dreaming time zone,
  every non-archived Hermes agent with memory dreams. A busy agent still dreams that
  night (as on OpenClaw); the builder decides whether that means waiting for its turn
  to end or running beside it.
- **Backup first:** shortly before the hour AgentPier copies both memory files of each
  Hermes agent, keeping the last 7 nights, like the existing `MEMORY.md` backups
  (`dreaming-backups.js`, `assistants/memory-backups/<agent>/`), now also covering
  `USER.md`.
- **The dream run:** with the agent's own model, it reads the agent's chats since its
  last dream (all of that agent's chats, including a shared agent's users' chats, as on
  OpenClaw) and both memory files, then writes new versions of both files that:
  - take in lasting facts and preferences from those chats,
  - merge duplicates and near-duplicates,
  - replace entries that newer information made outdated,
  - keep every protected entry word for word,
  - end at or below about **80 %** of each file's limit, to leave room for the day.
- **Guard (AgentPier, deterministic):** before applying the new files, AgentPier checks
  that every protected entry of the files as they were at the start of the night is
  still present, unchanged, in the same file, and that each file is within its limit.
  If not, nothing is applied (or the backup is restored), and the diary entry says the
  night was discarded and why. A file the agent changed in a chat during the dream is
  not overwritten blindly (the existing hash/absence check of the Hermes file adapter).
- **Diary:** each night appends one short entry to a Hermes dream diary shown first,
  read-only, on the agent's memory page as **Dream diary** (as `DREAMS.md` is for
  OpenClaw agents): what was added, merged, replaced or dropped, or that the night was
  discarded. Same visibility rules as the rest of the agent's memory (a user's own
  agent only while the owner may read chats). Size handling as for OpenClaw's diary
  (newest entries shown, older cut off beyond 256 KiB).
- **Undo:** documented like OpenClaw's: copy a backup back. (The builder may add a
  restore action if it is cheap, but it is not required.)
- **Deleting a chat:** later nights no longer read it; facts already consolidated from
  it stay, as on OpenClaw.

## Builder's calls (decided by me, check while reading)

- **Headroom vs. protected entries:** the guard checks only the hard limits and the
  protected entries. The 80 % target is an instruction to the dream, not a guard rule,
  so a night is never discarded because protected entries alone take more than 80 %.
  The memory page shows how much of each file protected entries take.
- **Writes during a dream:** the dream reads both files at its start. If the agent
  changed a file in a chat before the dream's result is applied, AgentPier does not
  overwrite it: the dream runs again once that night against the new state, and if the
  file changes again, the night is postponed to the next one (diary says so).
- **Cursor:** "since its last dream" means since the last **applied** night. A
  discarded or postponed night leaves the cursor where it was, so its chats are read
  again the next night and no fact is lost.
- **Downgrade:** an older AgentPier compiles the old limits again; Hermes then keeps
  loading a larger file but refuses the agent's writes until it is trimmed. Handled by
  an upgrade note in the release notes, no migration.
- **Who dreams:** as on OpenClaw, every non-archived Hermes agent with memory dreams,
  including users' own agents and temporary team members, each over its own chats.
  The "memory stays on while dreaming is on" lock covers permanent Hermes agents as it
  does OpenClaw's.

## Constraints

- Hermes has no API for its memory files; AgentPier reads and writes them directly,
  atomically, owner-only, over the hash it read (`hermes-files.js`). Keep that.
- Hermes freezes memory into a session's prompt when the session starts; consolidated
  memory reaches the agent's next chat.
- All UI text in German and English with confirmed translation locks; ⌘K search entries
  if a new page or action is added; live updates for the memory page if it shows the
  diary changing.
- Docs to update: `docs/agents.md` (Hermes list, Dreaming, Memory),
  `docs/hermes-runtime.md` (memory section, parity table), `docs/assistant-gateway.md`
  (Dreaming) where it says dreaming is OpenClaw's.
- Tests: contract test running a Hermes dream against the in-repo fake model (consolidates,
  keeps a protected entry, a night that drops a protected entry is discarded), unit tests
  for the guard and the limits, browser test for pins and the diary on the memory page.

## Left to the builder

- How the dream run is executed on Hermes (a Hermes cron job with a dream prompt bound to
  a hidden session, an RPC session started by AgentPier, or another route), and how it
  receives the day's chats and returns the new files, as long as the guard above sits
  between the run and the files.
- The exact dream prompt and the diary entry format.
- The exact marker, if `📌 ` proves awkward with Hermes or models.
- Where the Hermes diary is stored.

## Open for later

- Protected entries and the same guard for OpenClaw agents' `MEMORY.md` tidy-up.
- Per-agent memory size.
