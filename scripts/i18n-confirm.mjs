import { confirmLock, lockPaths } from "./i18n-translation-lock.mjs";

// Records the current German and English texts as reviewed. Run it after checking
// that the English translations match their German source.
for (const kind of Object.keys(lockPaths)) {
  const changed = await confirmLock(kind);
  console.log(`${lockPaths[kind]}: ${changed.length} entries updated`);
}
