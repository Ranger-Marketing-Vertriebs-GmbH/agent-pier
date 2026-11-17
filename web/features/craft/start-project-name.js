import {
  isShortProjectName,
  suggestProjectName,
} from "../../../server/features/projects/project-names.js";

export { isShortProjectName };

/**
 * The project name the start form shows: the owner's own once edited, else a short one
 * derived from the request and the target the form sends (empty when nothing sensible
 * is left, so the owner must name it). Never the request itself.
 */
export function shownProjectName(form) {
  if (form.nameEdited) return form.name;
  const target =
    form.targetKind === "url" || form.targetKind === "path" ? form.target : "";
  return suggestProjectName(form.request, target) ?? "";
}
