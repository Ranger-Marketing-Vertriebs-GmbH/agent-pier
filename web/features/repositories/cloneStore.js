import { cloneStoreCopy as copy } from "../../lib/i18n/de/repositories.js";
import api from "../../lib/api.js";
// A clone belongs to this browser tab, not the currently mounted page.
// Retain only its non-secret request and public project metadata.
let cloneOperation = {
  cloning: false,
  error: "",
  notice: "",
  request: null,
  projects: [],
};
const cloneListeners = new Set();
export const getCloneOperation = () => cloneOperation;
export function subscribeToClone(listener) {
  cloneListeners.add(listener);
  return () => cloneListeners.delete(listener);
}
function updateCloneOperation(update) {
  cloneOperation = {
    ...cloneOperation,
    ...update,
  };
  for (const listener of cloneListeners) listener();
}
export async function cloneRepository(request) {
  if (cloneOperation.cloning) return null;
  updateCloneOperation({
    cloning: true,
    error: "",
    notice: "",
    request,
  });
  try {
    const project = await api("/repositories/clone", "POST", request);
    updateCloneOperation({
      cloning: false,
      request: null,
      projects: [
        project,
        ...cloneOperation.projects.filter((item) => item.id !== project.id),
      ],
      notice: copy.notice(project.name),
    });
    return project;
  } catch (error) {
    updateCloneOperation({
      cloning: false,
      error: error.message,
    });
    return null;
  }
}
