import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Paths whose change can break the assistant runtime contracts. Keep in sync with
// the `paths` filters of .github/workflows/assistant-runtime.yml.
export const assistantRuntimePaths = [
  ".github/workflows/assistant-runtime.yml",
  ".github/workflows/assistant-runtime-queue.yml",
  "server/features/assistants/**",
  "server/features/assistant-channels/**",
  "server/application/assistant-graph.js",
  "server/features/operations/releases.js",
  "server/lib/storage.js",
  "scripts/*assistant*.mjs",
  "scripts/assistant-runtime-paths.mjs",
  "scripts/test-files.mjs",
  "scripts/test-runner.mjs",
  "scripts/test-retry.mjs",
  "scripts/test-failures-reporter.mjs",
  "tests/**/assistant*",
  "tests/helpers/openclaw-dist-exports.js",
  "tests/helpers/mcp-*",
  "server/features/mcp-servers/**",
  "server/http/routes/mcp-*",
  "package.json",
  "package-lock.json",
];

// GitHub filter semantics for the patterns above: `*` stays within one path
// segment, `**` spans segments, `**/` also matches no directory at all, and
// `dir/**` matches everything below dir.
export function globPattern(glob) {
  let source = "";
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index];
    if (glob.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 2;
    } else if (character === "*" && glob[index + 1] === "*") {
      source += ".*";
      index++;
    } else if (character === "*") source += "[^/]*";
    else source += character.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

const patterns = assistantRuntimePaths.map(globPattern);
export const assistantRuntimeRelevant = (files) =>
  files.some((file) => patterns.some((pattern) => pattern.test(file)));

// Changed files between the queue or PR base and the checked-out commit. Any
// error yields null, and the caller then runs the contracts. The base is fetched
// only when missing, and shallowly only in a clone that is already shallow (the
// CI checkout), so a full local clone never becomes shallow. Renames are listed
// as a deletion plus an addition, so moving a file out of an assistant path
// still counts as an assistant change.
export function changedFiles(base, run = execFileSync) {
  if (!/^[0-9a-f]{40}$/.test(base || "")) return null;
  try {
    const present = (() => {
      try {
        run("git", ["cat-file", "-e", `${base}^{commit}`], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    })();
    if (!present) {
      const shallow =
        run("git", ["rev-parse", "--is-shallow-repository"], {
          encoding: "utf8",
        }).trim() === "true";
      run(
        "git",
        ["fetch", "--no-tags", ...(shallow ? ["--depth=1"] : []), "origin", base],
        {
          stdio: "ignore",
        },
      );
    }
    return run("git", ["diff", "--no-renames", "--name-only", base, "HEAD"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return null;
  }
}

export function decide(base, run) {
  const files = changedFiles(base, run);
  if (!files) return { relevant: true, reason: "the changed files could not be read" };
  const relevant = assistantRuntimeRelevant(files);
  return {
    relevant,
    reason: relevant
      ? "assistant runtime paths changed"
      : `none of ${files.length} changed file(s) touches the assistant runtime`,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { relevant, reason } = decide(process.env.BASE_SHA);
  console.log(`Assistant runtime contracts ${relevant ? "run" : "skipped"}: ${reason}.`);
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `relevant=${relevant}\n`);
  if (process.env.GITHUB_STEP_SUMMARY && !relevant)
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Assistant runtime contracts skipped: ${reason}.\n`,
    );
}
