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
// agentpier_share_file by name (`generated`, which the plugin drops from every call of
// the model), which shares it into the chat its turn, routine or hook shares into
// (agent-shares.js turn) and keeps a copy for the agent in that chat's file folder
// as `generated-<name>` (chat-file-folders.js): on an agent shared with users only
// that chat reads it (hermes-home-guard.js), it counts against the agent's upload
// quota and it goes with the chat's other files. The home itself stays unreadable to
// an agent of restricted users.

/** The prefix of a created image's copy in its chat's file folder. */
export const generatedPrefix = "generated-";
const imageName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.(?:png|jpe?g|webp|gif)$/i;

/**
 * Copies the image `name` of the Hermes agent's `cache/generated/images/` into
 * `conversation`'s file folder: read as a share source (a regular file with one link,
 * no link on the way), then, in the agent's upload queue and within its quota
 * (agent-attachments.js), written beside it and renamed into place. Returns the read
 * source (`{ name, body, identity }`) with the copy's `path`.
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
  const uploads = assistants.attachments;
  return uploads.serial(agent.id, async () => {
    await uploads.assertQuota(agent.id, source.body.length);
    const folder = await checkedChatFolder(
      uploads.config,
      [agent.id, conversation.id],
      true,
    );
    const target = path.join(folder.path, generatedPrefix + source.name);
    // A new file of its own, then renamed: a link at the name is replaced, never
    // followed.
    const partial = path.join(folder.path, `.${randomBytes(8).toString("hex")}.partial`);
    try {
      await fs.writeFile(partial, source.body, { flag: "wx", mode: 0o600 });
      await fs.rename(partial, target);
    } catch {
      await fs.rm(partial, { force: true }).catch(() => {});
      throw assistantProblem("unavailable", 503);
    }
    return { ...source, path: target };
  });
}
