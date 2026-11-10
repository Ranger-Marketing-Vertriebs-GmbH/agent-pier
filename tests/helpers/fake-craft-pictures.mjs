import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// The fake Craft Anything's pictures of the original (fake-craft-mcp.mjs), as 0.6.0's
// add_references: copied into `reference/` as `picture-N.<ext>`, files that are not
// PNG, JPEG, WebP or GIF by name skipped, one over 20 MB refusing the call first.

const pictureName = /\.(png|jpe?g|webp|gif)$/i;

/** Refuses relative paths and a picture over 20 MB (`ToolError(code, message)`). */
export function checkPictures(files = [], ToolError) {
  if (!Array.isArray(files) || files.some((file) => !path.isAbsolute(file)))
    throw new ToolError("invalid_arguments", "pictures must be absolute paths.");
  for (const file of files)
    if (pictureName.test(file) && statSync(file).size > 20 * 1024 * 1024)
      throw new ToolError("over_limit", `${path.basename(file)} can't be attached.`);
}

/** Copies the pictures into `<folder>/reference`, numbering on from what is there. */
export function addPictures(folder, files = []) {
  const dir = path.join(folder, "reference");
  mkdirSync(dir, { recursive: true });
  for (const file of files.filter((name) => pictureName.test(name))) {
    const name = `picture-${readdirSync(dir).length + 1}.${pictureName.exec(file)[1]}`;
    copyFileSync(file, path.join(dir, name.toLowerCase()));
  }
}
