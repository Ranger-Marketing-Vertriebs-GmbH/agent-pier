import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const git = (root, args, input) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });

const list = (output) => output.split("\0").filter(Boolean);

// The tracked and untracked (not ignored) files of the working tree, from disk.
export function workingTree(root) {
  const files = list(
    git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
  ).filter((file) => fs.existsSync(path.join(root, file)));
  return {
    files,
    read: (file) => {
      try {
        return fs.readFileSync(path.join(root, file), "utf8");
      } catch {
        return null;
      }
    },
  };
}

// The files of one commit, read from the object store, so a historical commit
// can be analysed without checking it out.
export function commitTree(root, commit, wanted = () => true) {
  const entries = list(git(root, ["ls-tree", "-r", "-z", "--full-tree", commit]))
    .map((line) => {
      const [meta, file] = line.split("\t");
      const [mode, type, object] = meta.split(" ");
      return { mode, type, object, file };
    })
    .filter((entry) => entry.type === "blob");
  const texts = new Map();
  const load = entries.filter((entry) => wanted(entry.file));
  if (load.length) {
    const output = execFileSync("git", ["cat-file", "--batch"], {
      cwd: root,
      input: load.map((entry) => entry.object).join("\n") + "\n",
      maxBuffer: 1024 * 1024 * 1024,
    });
    let offset = 0;
    for (const entry of load) {
      const header = output.indexOf(10, offset);
      const size = Number(output.toString("utf8", offset, header).split(" ")[2]);
      texts.set(entry.file, output.toString("utf8", header + 1, header + 1 + size));
      offset = header + 1 + size + 1;
    }
  }
  return {
    files: entries.map((entry) => entry.file),
    read: (file) => texts.get(file) ?? null,
  };
}

// Files that differ between the merge base of `base` and `head`, and `head`.
// Renames count as a deletion plus an addition, so both paths are considered.
// Never fetches: a missing commit yields null and the caller runs everything.
export function changedFiles(root, base, head = "HEAD") {
  try {
    const output = git(root, [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      `${base}...${head}`,
    ]);
    return list(output);
  } catch {
    return null;
  }
}
