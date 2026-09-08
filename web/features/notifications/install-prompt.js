let prompt = null;
const listeners = new Set();
const changed = () => listeners.forEach((listener) => listener());
export function captureInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    prompt = event;
    changed();
  });
  window.addEventListener("appinstalled", () => {
    prompt = null;
    changed();
  });
}
export function subscribeInstallPrompt(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const readInstallPrompt = () => prompt;
export async function showInstallPrompt() {
  const current = prompt;
  prompt = null;
  changed();
  await current?.prompt();
}
