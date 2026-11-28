import { devicesCopy } from "../../lib/i18n/messages/devices.js";
import { deviceCreateAction } from "./device-actions.js";

// The ⌘K entries of Settings › General › Android devices (web/app/search-entries.js
// builds them into the index): the page, its groups and "New device".

// Words people type for it, in both languages; not labels, so not in the catalogs.
// Every word of a query must be in one of them, so the usual pairs are listed too.
const words = [
  "Android Emulator",
  "Android phone",
  "Android Handy",
  "Android Telefon",
  "Android Smartphone",
  "adb",
];
const createWords = [
  "New Android device",
  "New Android phone",
  "New phone",
  "Neues Android-Gerät",
  "Neues Android Handy",
  "Neues Handy",
  "Neues Telefon",
];

/** `general` is the label path "Settings › General"; `route` the page's route. */
export function devicePageEntries(pageEntry, bilingual, general, route) {
  const page = [...general, bilingual(() => devicesCopy.title)];
  return [
    pageEntry(
      "settings-devices",
      () => devicesCopy.title,
      general,
      { route },
      {
        extra: words,
      },
    ),
    ...[
      ["installation", () => devicesCopy.installation.group],
      ["list", () => devicesCopy.list.group],
      ["limits", () => devicesCopy.limits.group],
    ].map(([id, label]) => pageEntry(`settings-devices-${id}`, label, page, { route })),
  ];
}

/** "New device": opens the page and its dialog (usePageAction in DevicesPage.jsx). */
export const deviceActionEntries = (action, path, route) => [
  action(
    "new-device",
    () => devicesCopy.search.newDevice,
    path,
    { route, pending: deviceCreateAction },
    { extra: createWords },
  ),
];
