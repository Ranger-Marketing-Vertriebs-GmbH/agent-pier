import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import { readShareSource } from "./agent-share-source.js";
import { checkedChatFolder, keepsChatFolders } from "./chat-file-folders.js";
import { agentPrivateFolders } from "./runtimes/runtime-for.js";

// An image a Hermes agent created (image_generate) is saved by Hermes below its home,
// `cache/generated/images/`, beside every other chat's. The team plugin's
// `transform_tool_result` hook (hermes-config/team-plugin.js) hands it to
// agentpier_share_file by name (`generated`), which shares it into the chat its turn,
// routine or hook shares into (agent-shares.js turn) and keeps a copy for the agent in
// that chat's file folder, `<chat folder>/generated-images/` (chat-file-folders.js):
// on an agent shared with users only that chat reads it (hermes-home-guard.js), and
// it goes with the chat's other files. The home itself stays unreadable to an agent
// of restricted users.

/** The folder of a chat's file folder that holds the images created in that chat. */
export const generatedImagesFolder = "generated-images";
const imageName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.(?:png|jpe?g|webp|gif)$/i;

/**
 * Copies the image `name` of the Hermes agent's `cache/generated/images/` into the
 * generated-images folder of `conversation`'s file folder: read as a share source (a
 * regular file with one link, no link on the way), written beside it and renamed into
 * place. Returns the read source (`{ name, body, identity }`) with the copy's `path`.
 */
export async function keepGeneratedImage(assistants, agent, conversation, name) {
  const home = keepsChatFolders(agent)
    ? agentPrivateFolders(assistants.runtime, agent)?.[0]
    : null;
  if (!home || typeof name !== "string" || !imageName.test(name))
    throw assistantProblem("invalid");
  const source = await readShareSource(
    [path.join(home, "cache", "generated", "images")],
    name,
  );
  const folder = await checkedChatFolder(
    assistants.attachments.config,
    [agent.id, conversation.id, generatedImagesFolder],
    true,
  );
  const target = path.join(folder.path, source.name);
  // A new file of its own, then renamed: a link at the name is replaced, never followed.
  const partial = path.join(folder.path, `.${randomBytes(8).toString("hex")}.partial`);
  try {
    await fs.writeFile(partial, source.body, { flag: "wx", mode: 0o600 });
    await fs.rename(partial, target);
  } catch {
    await fs.rm(partial, { force: true }).catch(() => {});
    throw assistantProblem("unavailable", 503);
  }
  return { ...source, path: target };
}
