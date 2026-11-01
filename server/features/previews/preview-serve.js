import { listenerPort, TAILSCALE_LISTENER_OFFSET } from "./preview-slots.js";

/** The loopback listener Tailscale Serve forwards a slot to. */
const listener = (slot) => listenerPort(slot, { offset: TAILSCALE_LISTENER_OFFSET });
const target = (slot) => `http://127.0.0.1:${listener(slot)}`;

const slotsOf = (range) => {
  const ports = [];
  if (range) for (let port = range.start; port <= range.end; port++) ports.push(port);
  return ports;
};

const webEntries = (status, port) =>
  Object.entries(status?.Web || {}).filter(([host]) => host.endsWith(`:${port}`));

/**
 * Whether the Serve entry of `httpsPort` is AgentPier's (the rule of selectServePort):
 * one Web entry `:<port>` with the one handler `/` proxying the loopback listener.
 */
export function previewServeOwned(status, httpsPort, listenerPortNumber) {
  const web = webEntries(status, httpsPort);
  return (
    web.length === 1 &&
    Object.keys(web[0][1]?.Handlers || {}).length === 1 &&
    web[0][1].Handlers["/"]?.Proxy === `http://127.0.0.1:${listenerPortNumber}`
  );
}

const owned = (status, slot) => previewServeOwned(status, slot, listener(slot));
const occupied = (status, slot) =>
  Boolean(status?.TCP?.[slot]) || webEntries(status, slot).length > 0;

/** What the CLI said, on one short line (native CLI output keeps its language). */
const reasonOf = (error) =>
  String(error?.stderr || error?.message || "error")
    .trim()
    .split("\n")[0]
    .slice(0, 200) || "error";

/** The exact commands the owner can run for the slots of `range`. */
export function serveCommands(range) {
  return slotsOf(range).map(
    (slot) => `tailscale serve --bg --https=${slot} ${target(slot)}`,
  );
}

const readStatus = async (run) => JSON.parse(await run(["serve", "status", "--json"]));

/**
 * Registers every slot of `range` with Tailscale Serve once, idempotently: an owned slot
 * stays, a slot another program uses is reported, never overwritten. Owned slots of
 * `previousRange` outside `range` are switched off. Never throws.
 */
export async function applyPreviewServe({ run, range, previousRange = null }) {
  let status;
  try {
    status = await readStatus(run);
  } catch (error) {
    const reason = reasonOf(error);
    return {
      registered: [],
      failed: slotsOf(range).map((port) => ({ port, reason })),
      commands: serveCommands(range),
    };
  }
  const inside = new Set(slotsOf(range));
  for (const slot of slotsOf(previousRange))
    if (!inside.has(slot) && owned(status, slot))
      await run(["serve", `--https=${slot}`, "off"]).catch(() => {});
  const registered = [];
  const failed = [];
  const commands = [];
  for (const slot of inside) {
    if (owned(status, slot)) registered.push(slot);
    else if (occupied(status, slot)) failed.push({ port: slot, reason: "occupied" });
    else
      try {
        await run(["serve", "--bg", `--https=${slot}`, target(slot)]);
        registered.push(slot);
      } catch (error) {
        failed.push({ port: slot, reason: reasonOf(error) });
        commands.push(...serveCommands({ start: slot, end: slot }));
      }
  }
  return { registered, failed, commands };
}

/** Switches off AgentPier's own Serve entries of `range`; other entries stay. */
export async function removePreviewServe({ run, range }) {
  const removed = [];
  let status;
  try {
    status = await readStatus(run);
  } catch {
    return { removed };
  }
  for (const slot of slotsOf(range))
    if (owned(status, slot))
      try {
        await run(["serve", `--https=${slot}`, "off"]);
        removed.push(slot);
      } catch {}
  return { removed };
}

/** The `serve` of the preview view: null without a remote URL; network mode skips Serve. */
export function serveView(current, { registered, failed, commands }) {
  if (!current.remoteUrl) return null;
  if (current.network?.enabled)
    return { registered: [], failed: [], commands: [], skipped: "network" };
  return {
    registered: [...registered],
    failed: failed.map((entry) => ({ ...entry })),
    commands: [...commands],
  };
}
