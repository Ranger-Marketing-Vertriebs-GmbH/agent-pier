import { profilePluginsCopy as copy } from "../../lib/i18n/messages/plugins.js";

export function catalogReason(data) {
  return Object.hasOwn(copy.catalogReasons, data.catalogReasonCode)
    ? copy.catalogReasons[data.catalogReasonCode]
    : data.catalogReason;
}

export function pluginNote(data) {
  const codes = data.noteCodes;
  return Array.isArray(codes) &&
    codes.length &&
    codes.every((code) => Object.hasOwn(copy.notes, code))
    ? codes.map((code) => copy.notes[code]).join(" ")
    : data.note;
}
