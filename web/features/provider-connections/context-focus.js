import { contextFieldId } from "./endpoint-draft.js";

/** Scrolls a model row's context field into view and focuses it; false if absent. */
export function focusContextField(modelId) {
  const field = document.getElementById(contextFieldId(modelId));
  if (!field) return false;
  field.scrollIntoView?.({ block: "center" });
  field.focus({ preventScroll: true });
  return true;
}
