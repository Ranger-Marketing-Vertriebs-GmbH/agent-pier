// The texts of the runtimes' described fields (docs/adr/0007-runtime-descriptor.md),
// by runtime id: a reader of the runtime's own catalog namespace that answers
// `{ [fieldId]: { label, hint, options?: { [value]: label }, unit? } }`. Labels and
// hints never come from the server: a field the server describes needs its texts
// here, in German and in English (tests/unit/advanced-scopes.test.js fails for a
// shipped descriptor's field without them). No component here, so Node loads it.
//
// No shipped runtime describes a field yet. The first one adds its entry:
// `[runtimeId]: () => runtimeCopy.fields`, read from the reactive catalogs
// (web/lib/i18n/messages/).
const registered = Object.freeze({});

/**
 * The texts of described field `fieldId` of runtime `runtimeId` in the current
 * language, or undefined for a field (or runtime) this build has none for.
 */
export function runtimeFieldCopy(runtimeId, fieldId) {
  const read =
    typeof runtimeId === "string" && Object.hasOwn(registered, runtimeId)
      ? registered[runtimeId]
      : null;
  const texts = read?.();
  return texts && Object.hasOwn(texts, fieldId) ? texts[fieldId] : undefined;
}
