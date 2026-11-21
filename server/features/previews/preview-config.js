import { readJSON } from "../../lib/storage.js";
import { updateStoredConfig } from "../../lib/config.js";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { previewError } from "./preview-errors.js";
import { listenerPort, TAILSCALE_LISTENER_OFFSET } from "./preview-slots.js";

export const DEFAULT_PREVIEW_RANGE = Object.freeze({ start: 47100, end: 47109 });
export const MAX_PREVIEW_PORTS = 50;
const KEYS = new Set(["enabled", "portRangeStart", "portRangeEnd"]);

const defaults = (enabled = false) => ({
  enabled,
  portRangeStart: DEFAULT_PREVIEW_RANGE.start,
  portRangeEnd: DEFAULT_PREVIEW_RANGE.end,
});
const invalid = () => previewError("PREVIEW_RANGE_INVALID", 400);
/** PREVIEW_RANGE_INVALID with the message of the one rule the range breaks. */
const refused = (message) =>
  Object.assign(new Error(message), { code: "PREVIEW_RANGE_INVALID", status: 400 });
const range = serverMessages.previews;

/** The port of a remote URL (443 when it names none); null without a remote URL. */
export function tailscaleHttpsPort(remoteUrl) {
  if (!remoteUrl) return null;
  try {
    return Number(new URL(remoteUrl).port) || 443;
  } catch {
    return null;
  }
}

/** Validates a `previews` config; throws PREVIEW_RANGE_INVALID for anything unusable. */
export function normalizePreviewConfig(
  raw,
  { hostPort, pipelineRange, tailscaleHttpsPort: httpsPort } = {},
) {
  if (raw === undefined || raw === null) return defaults();
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  if (Object.keys(raw).some((key) => !KEYS.has(key))) throw invalid();
  const enabled = raw.enabled ?? false;
  if (typeof enabled !== "boolean") throw invalid();
  const start = raw.portRangeStart ?? DEFAULT_PREVIEW_RANGE.start;
  const end = raw.portRangeEnd ?? DEFAULT_PREVIEW_RANGE.end;
  if (!Number.isInteger(start) || !Number.isInteger(end))
    throw refused(range.rangeNotNumbers);
  // With Tailscale the listeners take slot + 1000 (preview-slots.js): checked always,
  // so a later `npm run tailscale` never makes a saved range unusable.
  const listener = (port) => listenerPort(port, { offset: TAILSCALE_LISTENER_OFFSET });
  const highest = 65535 - TAILSCALE_LISTENER_OFFSET;
  if (start < 1024 || listener(end) > 65535)
    throw refused(range.rangeBounds(1024, highest));
  if (end < start) throw refused(range.rangeOrder);
  if (end - start + 1 > MAX_PREVIEW_PORTS)
    throw refused(range.rangeSize(MAX_PREVIEW_PORTS));
  // Each rule names the port it hit; a listener's port is named with its slot.
  for (const [low, high, offset] of [
    [start, end, 0],
    [listener(start), listener(end), TAILSCALE_LISTENER_OFFSET],
  ]) {
    const inside = (port) => Number.isInteger(port) && port >= low && port <= high;
    const named = (port, direct, viaListener) =>
      offset ? viaListener(port - offset, port) : direct(port);
    if (inside(hostPort))
      throw refused(named(hostPort, range.rangeHostPort, range.rangeHostPortListener));
    if (inside(httpsPort))
      throw refused(named(httpsPort, range.rangeHttpsPort, range.rangeHttpsPortListener));
    if (pipelineRange && low <= pipelineRange.end && high >= pipelineRange.start)
      throw refused(
        offset
          ? range.rangePipelinesListener(pipelineRange.start, pipelineRange.end)
          : range.rangePipelines(pipelineRange.start, pipelineRange.end),
      );
  }
  return { enabled, portRangeStart: start, portRangeEnd: end };
}

/** The saved config; an invalid stored range falls back to the default, enabled kept. */
export function readPreviewConfig(dataDir, constraints) {
  const raw = readJSON(path.join(dataDir, "config.json"), {}).previews;
  try {
    return normalizePreviewConfig(raw, constraints);
  } catch {
    return defaults(raw?.enabled === true);
  }
}

export function writePreviewConfig(dataDir, previews) {
  return updateStoredConfig(dataDir, { previews }).previews;
}
