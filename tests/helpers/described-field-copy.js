// Which described fields of a runtime descriptor lack a text in a catalog (ADR 0007,
// step 4): labels and hints of described fields never come from the server, so every
// field needs both in German and in English. `copyOf(language)` answers the field
// texts of the runtime in that language: `{ [fieldId]: { label, hint, options? } }`.
const text = (value) => typeof value === "string" && value.trim() !== "";

/**
 * The texts `descriptor`'s described fields lack, as `language: runtime.field.what`:
 * a label, a hint, and for a select a label per option. [] when none is missing.
 */
export function missingFieldCopy(descriptor, copyOf, languages = ["de", "en"]) {
  const missing = [];
  for (const language of languages) {
    const copy = copyOf(language) || {};
    for (const surface of descriptor.surfaces)
      for (const field of surface.fields || []) {
        const entry = Object.hasOwn(copy, field.id) ? copy[field.id] : null;
        const lacks = (what) =>
          missing.push(`${language}: ${descriptor.id}.${field.id}.${what}`);
        if (!text(entry?.label)) lacks("label");
        if (!text(entry?.hint)) lacks("hint");
        for (const option of field.options || [])
          if (!text(entry?.options?.[option])) lacks(`options.${option}`);
      }
  }
  return missing;
}
