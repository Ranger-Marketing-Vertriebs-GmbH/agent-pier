import { isCodingCli } from "../../../server/features/clis/catalog.js";
import { devicesCopy as copy } from "../../lib/i18n/messages/devices.js";
import { codeText } from "./device-view.js";

// The Android devices of one coding session as the owner chooses them: in the
// new-session dialog (sent as `deviceAccess`) and in a running session's dialog
// (GET/PUT /api/sessions/:id/devices, live topic `session.devices:<id>`). A draft is
// the body both take, `{ devices: [{ deviceId, manage }], create }`. Pure, so every
// rule is tested without a browser (tests/unit/session-device-access.test.js).

/** A draft that grants nothing. */
export const noAccess = () => ({ devices: [], create: false });

/** Whether `value` is a session's device access this build can show. */
export const validAccess = (value) =>
  !!value &&
  Array.isArray(value.devices) &&
  typeof value.availability?.available === "boolean" &&
  typeof value.eligible === "boolean" &&
  typeof value.create === "boolean";

/**
 * Whether the session's menu offers its devices: a running coding CLI, not a sign-in,
 * pipeline or imported session (server deviceEligible). The server knows one more
 * rule, a session a restricted user's agent started; the dialog says so (`eligible`).
 */
export const deviceEligibleSession = (session) =>
  session?.status === "running" &&
  isCodingCli(session.tool) &&
  session.purpose !== "login" &&
  !session.pipeline &&
  !session.imported;

/** The draft of what the server reports: the owner's grants and the permission. */
export const accessDraft = (access) => ({
  devices: access.devices
    .filter((device) => device.assigned)
    .map((device) => ({ deviceId: device.id, manage: device.manage === true })),
  create: access.create === true,
});

/** The ids the draft grants, for GrantPicker's `selected`. */
export const grantedIds = (draft) => draft.devices.map((entry) => entry.deviceId);

/**
 * The draft with exactly `ids` granted, in that order: a device already granted
 * keeps its "reset and delete", a new one starts without it.
 */
export function withGranted(draft, ids) {
  const before = new Map(draft.devices.map((entry) => [entry.deviceId, entry.manage]));
  return {
    ...draft,
    devices: [...new Set(ids)].map((deviceId) => ({
      deviceId,
      manage: before.get(deviceId) === true,
    })),
  };
}

/** The draft with "reset and delete" of device `id` switched. */
export const withManage = (draft, id, manage) => ({
  ...draft,
  devices: draft.devices.map((entry) =>
    entry.deviceId === id ? { ...entry, manage } : entry,
  ),
});

/** The draft without devices that are not in `devices` any more (`[{ id }]`). */
export function prunedDraft(draft, devices) {
  const known = new Set(devices.map((device) => device.id));
  const kept = draft.devices.filter((entry) => known.has(entry.deviceId));
  return kept.length === draft.devices.length ? draft : { ...draft, devices: kept };
}

/** Whether two drafts grant the same, whatever the order of their devices. */
export function sameAccess(a, b) {
  if (a.create !== b.create || a.devices.length !== b.devices.length) return false;
  const other = new Map(b.devices.map((entry) => [entry.deviceId, entry.manage]));
  return a.devices.every((entry) => other.get(entry.deviceId) === entry.manage);
}

/** Whether the draft grants anything; a launch sends only one that does. */
export const grantsAnything = (draft) => draft.create || draft.devices.length > 0;

/**
 * `devices` (`[{ id, name, own? }]`) as GrantPicker entries. A device the session
 * created is its own: always allowed, with the reason as its note (`ownNote`, which
 * an agent's settings word for the agent).
 */
export const deviceGrantEntries = (devices, ownNote = copy.access.own) =>
  devices.map((device) => ({
    id: device.id,
    name: device.name,
    locked: device.own === true,
    notes: device.own ? [ownNote] : [],
  }));

/**
 * The "reset and delete" switches: one per granted device that still exists and is
 * not the session's own (its own it always manages), in the order of `devices`.
 */
export function manageRows(draft, devices) {
  const granted = new Map(draft.devices.map((entry) => [entry.deviceId, entry.manage]));
  return devices
    .filter((device) => granted.has(device.id) && !device.own)
    .map((device) => ({
      id: device.id,
      name: device.name,
      manage: granted.get(device.id) === true,
    }));
}

/** What the new-session dialog's summary line says of the draft, or "". */
export function launchSummary(draft) {
  const { launch: text } = copy.access;
  return [
    draft.devices.length ? text.summary(draft.devices.length) : "",
    draft.create ? text.summaryCreate : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * Why the dialog offers no choice for `access`, or "": the host cannot run devices
 * (its reason in words), or this session cannot be given any.
 */
export function accessBlocked(access) {
  if (!access.availability.available)
    return codeText(access.availability.reason || "DEVICE_UNAVAILABLE");
  return access.eligible ? "" : codeText("DEVICE_SESSION_INELIGIBLE");
}
