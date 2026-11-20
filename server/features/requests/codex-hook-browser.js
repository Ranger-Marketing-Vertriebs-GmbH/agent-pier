// Codex's hooks browser: the view that "1. Review hooks" on the startup menu (or
// /hooks) opens. A bare `t` in it trusts every hook it lists and `space` toggles one,
// so chat text typed into it would decide about hooks the owner never looked at
// (docs/coding-clis.md). AgentPier holds chat input while it shows hooks to review
// and offers the decision as a hook-trust card.
import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { problem } from "../../lib/storage.js";
import { requestCopy as copy } from "../../lib/i18n/de/requests.js";
import { cliDefinition, isCodingCli } from "../clis/catalog.js";

const SUBTITLES = {
  list: "Lifecycle hooks from config and enabled plugins.",
  detail: "Turn hooks on or off. Your changes are saved automatically.",
};
const REVIEW = /^(?:⚠ )?(\d+) hooks? needs? review before (?:it|they) can run\./;
const FOOTER = { list: / esc close$/, detail: / esc back$/ };
// Event rows of the list view while it has a Review column: name, installed,
// active, review, description.
const ROW = /^(?:› )?\s*([A-Z][A-Za-z]+)\s+\d+\s+\d+\s+(\d+)\s{2,}\S/;

/**
 * `{ view: "list" | "detail", count, events }` while the browser is the last thing
 * on screen, or null. `count` is the number of hooks it says need review and
 * `events` the events they belong to. Wrapped rows (a narrow terminal) still match.
 */
export function hookBrowserScreen(raw) {
  if (typeof raw !== "string" || raw.length > 64000) return null;
  const lines = stripVTControlCharacters(raw).replaceAll(" ", " ").split("\n");
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  // The nearest title above the footer: "Hooks" or "<Event> hooks", indented by two.
  let title = end;
  while (title >= 0 && !/^ {2}(?:Hooks|[A-Z][A-Za-z]+ hooks)\s*$/.test(lines[title]))
    title--;
  if (title < 0 || end - title > 80) return null;
  const heading = lines[title].trim();
  const view = heading === "Hooks" ? "list" : "detail";
  const body = lines
    .slice(title + 1, end + 1)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!FOOTER[view].test(" " + body)) return null;
  let rest = body;
  if (rest.startsWith(SUBTITLES[view])) rest = rest.slice(SUBTITLES[view].length).trim();
  else if (view === "list" || !REVIEW.test(rest)) return null;
  const count = Number(rest.match(REVIEW)?.[1] || 0);
  const events =
    count === 0
      ? []
      : view === "detail"
        ? [heading.slice(0, -" hooks".length)]
        : lines
            .slice(title + 1, end)
            .map((line) => line.match(ROW))
            .filter((match) => match && Number(match[2]) > 0)
            .map((match) => match[1]);
  return { view, count, events };
}

// The CLIs that make the owner review hooks in their own terminal (Codex).
const candidate = (broker, session) =>
  isCodingCli(session?.tool) &&
  cliDefinition(session.tool).capabilities.hookTrust === true &&
  Boolean(session.nativeRequests?.enabled) &&
  session.status === "running" &&
  Boolean(broker.sessions.control);

const hookCards = (broker, sessionId) =>
  [...broker.entries.values()].filter(
    (entry) => entry.sessionId === sessionId && entry.presentation === "codexHookTrust",
  );

const expire = (broker, entry) => {
  // A read queued behind an answer must not expire the request that answer removed.
  if (!entry || broker.entries.get(entry.id) !== entry) return;
  broker.entries.delete(entry.id);
  broker.expired(entry, "startup");
};

/**
 * Publishes an open hooks browser with hooks to review as a hook-trust card of
 * session `sessionId`, or expires that card once the browser is gone. A card from
 * Codex's own startup hook list covers the browser already.
 */
export async function refreshHookBrowser(broker, sessionId) {
  const session = await broker.sessions.get(sessionId);
  if (!candidate(broker, session)) return;
  const cards = hookCards(broker, session.id);
  const previous = cards.find((entry) => entry.local);
  if (cards.some((entry) => entry !== previous)) return;
  await broker.sessions.control(session.id, async (control) => {
    const screen = hookBrowserScreen(await control.screen());
    if (!screen?.count) return expire(broker, previous);
    const launchIdentity = await broker.launchIdentity(session.id);
    const id = createHash("sha256")
      .update(`codex-hook-browser:${session.id}:${launchIdentity}`)
      .digest("hex");
    if (broker.entries.has(id)) return;
    expire(broker, previous);
    const entry = {
      id,
      sessionId: session.id,
      accountId: session.accountId,
      launchIdentity,
      local: true,
      presentation: "codexHookTrust",
      kind: "permission",
      hookCount: Math.min(screen.count, 100),
      revision: 1,
      status: "pending",
      source: session.tool,
      createdAt: new Date().toISOString(),
      subject: {
        tool: "Codex hooks",
        cwd: session.cwd,
        command: screen.events.join("\n"),
      },
      options: [
        { id: "trust", label: "Trust all and continue", scope: "persistent" },
        { id: "skip", label: "Continue without trusting" },
      ],
    };
    broker.entries.set(id, entry);
    broker.emit(entry, "request.created");
  });
}

/**
 * Answers a hook-trust card while the browser is open: "trust" presses the list
 * view's `t` (trust all) and waits until nothing is left to review; both choices
 * then close the browser with Escape (a detail view goes back to the list first).
 */
export async function answerHookBrowser(broker, entry, choice, control) {
  const read = async () => hookBrowserScreen(await control.screen());
  const settle = async (done) => {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const screen = await read();
      if (done(screen)) return screen;
      await delay(25);
    }
    throw problem(copy.unknown, 409);
  };
  if ((await broker.launchIdentity(entry.sessionId)) !== entry.launchIdentity)
    throw problem(copy.stale, 409);
  let screen = await read();
  if (!screen || broker.entries.get(entry.id) !== entry) throw problem(copy.stale, 409);
  if (choice === "trust" && screen.count) {
    if (screen.view === "detail") {
      await control.keys(["Escape"]);
      screen = await settle((next) => next?.view === "list");
    }
    await control.keys(["t"]);
    screen = await settle((next) => next?.view === "list" && next.count === 0);
  }
  for (let step = 0; screen && step < 2; step++) {
    const before = screen.view;
    await control.keys(["Escape"]);
    screen = await settle((next) => !next || next.view !== before);
  }
  if (screen) throw problem(copy.unknown, 409);
}
