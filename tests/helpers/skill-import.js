/**
 * Installs a skill source the way the browser does: preview (read and scan), then
 * confirm with the preview's hash. Warnings are accepted; a blocking scan is not
 * overridden, so a fixture that blocks fails here instead of installing.
 */
export async function previewAndInstall(store, id, input) {
  const preview = await store.previewSkill(id, input);
  return store.installSkill(id, {
    previewId: preview.previewId,
    contentHash: preview.contentHash,
    acceptWarnings: preview.verdict === "warn",
  });
}
