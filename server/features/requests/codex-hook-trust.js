import { randomUUID, createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { problem } from "../../lib/storage.js";
import { requestCopy as copy } from "../../lib/i18n/de/requests.js";

// This local TUI screen is not an app-server approval request. Never infer it
// from conversation prose: require the complete cleared startup view.
export function hookTrustScreen(raw) {
  if (typeof raw !== "string" || raw.length > 64000) return null;
  const text = stripVTControlCharacters(raw).replaceAll("\u00a0", " ").trim();
  if (!text.startsWith("Hooks need review\n")) return null;
  const compact = text.replace(/\s+/g, " ");
  const match = compact.match(
    /^Hooks need review (\d+) hooks? (?:is|are) new or changed\. Hooks can run outside the sandbox/,
  );
  if (!match || !compact.endsWith("Press enter to confirm or esc to go back"))
    return null;
  const choices = compact.match(
    /([› ]*)1\. Review hooks ([› ]*)2\. Trust all and continue ([› ]*)3\. Continue without trusting \(hooks won't run\) Press enter to confirm or esc to go back$/,
  );
  if (!choices) return null;
  const selected = [1, 2, 3].filter((i) => choices[i].includes("›"));
  if (selected.length !== 1) return null;
  return {
    count: Number(match[1]),
    selected: selected[0],
    error: compact.includes("Failed to trust hooks:"),
  };
}

/** Corroborate startup UI with the real TUI's hooks/list RPC, before any thread starts. */
export function observeHookTrust(channel) {
  let startup = true,
    pending = null;
  const lists = new Map(),
    writes = new Set();
  const clear = (outcome) => {
    if (pending) channel.resolve(pending.key, outcome);
    pending = null;
  };
  return {
    outgoing(message) {
      if (/^thread\/(start|resume|fork)$/.test(message.method || "")) {
        startup = false;
        clear();
      }
      if (message.method === "hooks/list" && startup) {
        clear();
        if (Array.isArray(message.params?.cwds) && message.params.cwds.length === 1)
          lists.set(JSON.stringify(message.id), message.params.cwds[0]);
      }
      if (
        pending &&
        message.method === "config/batchWrite" &&
        message.params?.edits?.some(
          (edit) =>
            edit.keyPath === "hooks.state" &&
            pending.hooks.every(
              (hook) => edit.value?.[hook.key]?.trusted_hash === hook.currentHash,
            ),
        )
      )
        writes.add(JSON.stringify(message.id));
    },
    incoming(message) {
      const id = JSON.stringify(message.id);
      if (writes.delete(id) && !message.error) clear("trusted");
      const cwd = lists.get(id);
      if (!cwd) return;
      lists.delete(id);
      if (!startup || cwd !== channel.launch?.cwd) return;
      const hooks = message.result?.data?.find((entry) => entry.cwd === cwd)?.hooks;
      if (!Array.isArray(hooks)) return;
      const needed = hooks.filter((hook) =>
        ["untrusted", "modified"].includes(hook?.trustStatus),
      );
      if (
        !needed.length ||
        needed.length > 100 ||
        needed.some(
          (hook) => typeof hook.key !== "string" || typeof hook.currentHash !== "string",
        )
      )
        return;
      const key = randomUUID();
      const detail = needed
        .map((hook) =>
          [
            hook.eventName,
            hook.sourcePath,
            hook.command || [hook.server, hook.tool].filter(Boolean).join("/"),
            hook.key,
          ]
            .filter(Boolean)
            .join("\n"),
        )
        .join("\n\n");
      pending = { key, hooks: needed };
      channel.publish(
        key,
        {
          kind: "permission",
          presentation: "codexHookTrust",
          hookCount: needed.length,
          subject: { tool: "Codex hooks", cwd, command: detail.slice(0, 30000) },
          options: [
            { id: "trust", label: "Trust all and continue", scope: "persistent" },
            { id: "skip", label: "Continue without trusting" },
          ],
        },
        async () => clear(),
      );
    },
    close() {
      startup = false;
      lists.clear();
      writes.clear();
      clear();
    },
  };
}

export async function answerHookTrust(broker, entry, choice) {
  if (!["trust", "skip"].includes(choice)) throw problem(copy.invalid, 400);
  return broker.sessions.control(entry.sessionId, async (control) => {
    const session = control.session;
    if (
      session.accountId !== entry.accountId ||
      session.tool !== "codex" ||
      !session.nativeRequests?.enabled ||
      broker.entries.get(entry.id) !== entry
    )
      throw problem(copy.stale, 409);
    const target = choice === "trust" ? 2 : 3;
    let screen = hookTrustScreen(await control.screen());
    if (!screen || screen.count !== entry.hookCount) throw problem(copy.stale, 409);
    // Select with native navigation, then re-inspect before the explicit Enter.
    if (screen.selected !== target)
      await control.keys(
        Array(Math.abs(target - screen.selected)).fill(
          target > screen.selected ? "Down" : "Up",
        ),
      );
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      screen = hookTrustScreen(await control.screen());
      if (
        !screen ||
        screen.count !== entry.hookCount ||
        broker.entries.get(entry.id) !== entry
      )
        throw problem(copy.stale, 409);
      if (screen.selected === target) break;
      await delay(25);
    }
    if (screen.selected !== target) throw problem(copy.stale, 409);
    // The private launch changes on reload/account switch, independent of screen text.
    const current = await broker.launchIdentity(entry.sessionId);
    if (current !== entry.launchIdentity) throw problem(copy.stale, 409);
    await control.keys(["Enter"]);
    const end = Date.now() + 2500;
    while (Date.now() < end) {
      await delay(25);
      const next = hookTrustScreen(await control.screen());
      if (choice === "trust" ? entry.nativeOutcome === "trusted" : !next) return;
      if (next?.error) throw problem(copy.unknown, 409);
    }
    throw problem(copy.unknown, 409);
  });
}
export const hookLaunchIdentity = (launch) =>
  createHash("sha256")
    .update(JSON.stringify([launch.id, launch.accountId, launch.tool, launch.token]))
    .digest("hex");
