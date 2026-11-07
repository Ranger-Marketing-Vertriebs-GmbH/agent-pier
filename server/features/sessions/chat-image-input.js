import { stat } from "node:fs/promises";
import { waitForNativeImages } from "./native-image-paste.js";
import { composerProblem } from "./claude-composer.js";
import { cliDefinition } from "../clis/catalog.js";
import { cliDriver } from "../clis/drivers.js";

/**
 * Refuses, before anything is typed, images the CLI would refuse as a whole:
 * their base64 size (4 bytes per 3, as the CLI sends them) above its limit.
 */
export async function requireImageBudget(tool, files) {
  const limit = cliDriver(tool).tui.images?.maxEncodedBytes;
  if (!limit) return;
  let encoded = 0;
  // A file that cannot be read is left to the CLI, which reports it itself.
  for (const file of files)
    encoded += Math.ceil(((await stat(file).catch(() => null))?.size ?? 0) / 3) * 4;
  if (encoded > limit) throw composerProblem("CHAT_IMAGES_TOO_LARGE");
}

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
  // Chip CLIs take every image in one paste; the others one image path per paste.
  const chips = cliDefinition(session.tool).capabilities.imagePaste;
  const rules = cliDriver(session.tool).tui.images;
  const wait = (count) =>
    (rules.wait ?? waitForNativeImages)(
      manager,
      session,
      (exact ? initialImages : 0) + count,
      { timeoutMs: imageTimeoutMs, exact },
    );
  let ready = true;
  if (resume !== "text") {
    await requireImageBudget(session.tool, images.images);
    if (!chips) await onDialog();
    await onPhase("paste-intent");
    if (chips) {
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
        await paste(rules.pathText(file));
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
