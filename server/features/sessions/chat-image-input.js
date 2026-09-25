import { waitForClaudeImages } from "./claude-image-paste.js";
import { waitForNativeImages } from "./native-image-paste.js";

/** Images become native chips before the text can hide them in a long prompt. */
export async function writeChatImages({
  manager,
  session,
  images,
  resume,
  initialImages,
  imageTimeoutMs,
  onPhase,
  onNotice,
  onDialog,
  pastePrefix,
  paste,
}) {
  const exact = Number.isInteger(initialImages) && initialImages >= 0;
  const wait = (count) =>
    (session.tool === "claude" ? waitForClaudeImages : waitForNativeImages)(
      manager,
      session,
      (exact ? initialImages : 0) + count,
      { timeoutMs: imageTimeoutMs, exact },
    );
  let ready = true;
  if (resume !== "text") {
    if (session.tool !== "claude") await onDialog();
    await onPhase("paste-intent");
    if (session.tool === "claude") {
      await paste(images.images.join("\n"));
      await onPhase("images-pasted");
      ready = await wait(images.images.length);
      if (ready === "dialog") {
        await onDialog();
        ready = await wait(images.images.length);
      }
    } else {
      // Codex/OpenCode recognize a paste containing exactly one image path.
      // A failure partway through remains paste-intent: never replay the batch.
      for (const [index, file] of images.images.entries()) {
        if (index > 0) await onDialog();
        // Codex tokenizes bare paths on spaces; a quoted path remains one image.
        await paste(session.tool === "codex" ? JSON.stringify(file) : file);
        const result = await wait(index + 1);
        if (result === "dialog") await onDialog();
        ready = ready && result === true;
      }
      await onPhase("images-pasted");
    }
  }
  if (ready !== true) await onNotice("CHAT_IMAGES_MAYBE_MISSING");
  if (images.text) {
    await onPhase("text-intent");
    await paste(pastePrefix() + images.text);
  }
  await onPhase("pasted");
}
