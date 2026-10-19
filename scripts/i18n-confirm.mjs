import { confirmLock, lockPaths } from "./i18n-translation-lock.mjs";

// Records the current German and English texts as reviewed. Run it after checking
// that the English translations match their German source. Arguments limit it to
// keys, key prefixes or web catalogs, for example
// `npm run i18n:confirm -- telegram-senders notifications.invalidPreferences`.
const selection = process.argv.slice(2);
let total = 0;
for (const kind of Object.keys(lockPaths)) {
  const { added, changed, removed } = await confirmLock(kind, selection);
  const lines = [
    ...added.map((key) => `  + ${key}`),
    ...changed.map((key) => `  ~ ${key}`),
    ...removed.map((key) => `  - ${key}`),
  ];
  total += lines.length;
  console.log(`${lockPaths[kind]}:${lines.length ? "" : " nothing to confirm"}`);
  for (const line of lines) console.log(line);
}
if (total) console.log("+ added  ~ changed  - removed");
