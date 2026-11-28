// Android devices (application/device-wiring.js): who created, reset or deleted a
// device, and the stable code of a failed SDK installation. Never a device name.
const callers = ["owner", "session", "agent"];

export function deviceAuditDetails(details, event) {
  if (callers.includes(details.caller)) event.details.caller = details.caller;
  if (typeof details.code === "string" && /^DEVICES?_[A-Z0-9_]{1,60}$/.test(details.code))
    event.details.code = details.code;
}
