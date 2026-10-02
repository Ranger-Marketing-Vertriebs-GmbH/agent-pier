export const UPDATE_EVENT = "agentpier-update-available";
let detected = false;
export function currentBuild() {
  return (
    globalThis.document?.querySelector('meta[name="agentpier-build"]')?.content || ""
  );
}
// Compares the server's build with this page's build; reports a mismatch once.
export function observeBuild(response, own = currentBuild()) {
  const served = response?.headers?.get?.("x-agentpier-build") || "";
  if (!detected && own && served && own !== served) {
    detected = true;
    globalThis.window?.dispatchEvent(new Event(UPDATE_EVENT));
  }
  return response;
}
export function updateDetected() {
  return detected;
}
export function resetBuildCheck() {
  detected = false;
}
