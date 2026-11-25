import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { atomicText, safePath, textFile } from "../extensions/mcp-config.js";

const skills = ["agentpier-composer"];

// Helpers shipped earlier whose unchanged copy must not stay in a profile. The one of
// 2.21.0-rc.2 and rc.3 passes its request to a child through a pipe, which on macOS
// can stall for good on an order above 64 KiB.
const replacedOrderHelpers = new Set([
  "e3f6d2a4a4a5151e6b693c6dc262ea8229e60c3f669d4830a8d6bb67d3ee1c0f",
]);

// Replaces such a helper with the shipped one. A helper the user edited, removed or
// got from elsewhere has another content and stays as it is.
function refreshOrderHelper(directory, boundary) {
  const helper = path.join(directory, "scripts", "order-progress.mjs");
  const before = textFile(helper, boundary);
  if (!replacedOrderHelpers.has(createHash("sha256").update(before).digest("hex")))
    return;
  atomicText(
    helper,
    boundary,
    before,
    fs.readFileSync(
      new URL("./skills/agentpier-composer/scripts/order-progress.mjs", import.meta.url),
      "utf8",
    ),
  );
}

// Seed once per native profile. Existing packages and later deletions belong to
// the user; a release or another account launch must not replace those choices.
// The one exception is an unchanged earlier helper with a known defect.
export function seedBundledSkills(dataDir, target) {
  const file = path.join(dataDir, "bundled-skills.json");
  const state = readJSON(file, {});
  const saved = (state[target.root] ||= []);
  for (const name of skills) {
    if (saved.includes(name)) continue;
    const parent = path.join(target.root, "skills");
    safePath(parent, target.boundary);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const directory = path.join(parent, name);
    let created = false;
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (created) {
      let staging;
      try {
        staging = fs.mkdtempSync(path.join(parent, `.install-${name}-`));
        for (const relative of [
          "SKILL.md",
          "agents/openai.yaml",
          "scripts/order-progress.mjs",
        ]) {
          const destination = path.join(staging, relative);
          fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
          fs.copyFileSync(
            new URL(`./skills/${name}/${relative}`, import.meta.url),
            destination,
            fs.constants.COPYFILE_EXCL,
          );
          fs.chmodSync(destination, 0o600);
        }
        // Publish all skill files together into the empty directory we reserved.
        fs.renameSync(staging, directory);
      } catch (error) {
        // Remove only an empty directory we just created, never another package.
        try {
          fs.rmdirSync(directory);
        } catch {
          // Retain any content written before the failure.
        }
        throw error;
      } finally {
        if (staging) fs.rmSync(staging, { recursive: true, force: true });
      }
    }
    saved.push(name);
    writePrivate(file, state);
  }
  try {
    refreshOrderHelper(
      path.join(target.root, "skills", "agentpier-composer"),
      target.boundary,
    );
  } catch {
    // A helper that cannot be read or replaced safely stays; the session still starts.
  }
}

// Known shipped briefs from before managed orders. Upgrade only on an explicit
// order launch. A normal session keeps its original installed package.
const stockComposerBriefs = new Set([
  "ed0b161525efff2e0aa33d3faa0ae05ee00e48167aeb7b90fd539294363a9a16",
  "25b9a52040566d19d6daecfbc0ed29be60d964692db2423c66202253fdf0bd12",
  "16ed121fe546b1bdee2e5970bd99cb73afa6df1c00c85fce099846a185b08b3f",
  "fda928293b998e2b9ba428b82ea82456e389b6b545e6dfaebb03c7b355e7b142",
  "a5d977061aabeb4f183d018ae04d373175600b4b155cc0aa71f77b3c07ddfd2f",
  "3fc4a41d8adf53274b320fc7e64bdaa868e47952d86c86640e88353b9c96c1f1",
  "378d3bec29d81e76ee70d770e9510a4e6388c9b06e1c2872f587f08cff36118d",
]);

export function upgradeStockComposerForOrder(directory, boundary) {
  const file = path.join(directory, "SKILL.md");
  const before = textFile(file, boundary);
  if (!stockComposerBriefs.has(createHash("sha256").update(before).digest("hex"))) return;
  const packaged = (relative) =>
    fs.readFileSync(
      new URL(`./skills/agentpier-composer/${relative}`, import.meta.url),
      "utf8",
    );
  const helper = path.join(directory, "scripts", "order-progress.mjs");
  const script = packaged("scripts/order-progress.mjs");
  const existing = textFile(helper, boundary);
  if (existing !== script) {
    if (fs.existsSync(helper)) return;
    atomicText(helper, boundary, "", script);
  }
  atomicText(file, boundary, before, packaged("SKILL.md"));
}
