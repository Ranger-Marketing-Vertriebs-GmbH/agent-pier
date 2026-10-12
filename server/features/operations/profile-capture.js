import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { problem } from "../../lib/storage.js";
import { sharedAssetLinks } from "../cli-profiles/backup-links.js";
import { readFile, readJson } from "./files.js";
import { classify, descend, nativeRoots } from "./profile-allowlist.js";
import {
  ensureSpace,
  formatBytes,
  profileComponent,
  toolNames,
} from "./backup-components.js";
import { fileMember, sqliteSnapshotFileAsync } from "./snapshot.js";

// The capsule is sealed in memory; the allowlist keeps it far below these limits.
const PROFILE_CREDENTIAL_LIMIT = 64 * 1024 * 1024;
const CREDENTIAL_LIMIT = 160 * 1024 * 1024;
export const profileOmissions = Object.freeze({
  unlisted: "CLI caches, logs, telemetry and files outside the profile allowlists",
  history: "CLI conversation histories",
  // History chosen, but no passphrase: CLI histories are only archived sealed.
  unsealed:
    "CLI histories are only backed up in backups with a passphrase, and then encrypted",
  linked: "Linked, shared or foreign files in CLI profiles",
});
const segment = /^[A-Za-z0-9_-]+$/;

/** The folders of a profile holding a CLI's native roots: its own and per provider. */
function profileBases(base) {
  const bases = [base],
    providers = path.join(base, "providers");
  if (fs.existsSync(providers) && fs.lstatSync(providers).isDirectory())
    for (const name of fs.readdirSync(providers).sort())
      if (segment.test(name)) bases.push(path.join(providers, name));
  return bases;
}

/**
 * Captures the allowlisted part of every managed CLI profile (profile-allowlist.js):
 * credentials and configuration into the capsule when `withCredentials`, the CLI's
 * conversation history (members with `history: true`, sealed by the backup) when
 * `includeHistory` and `withCredentials`. Links and foreign
 * files are skipped, never followed; database histories become snapshots.
 */
export async function captureProfiles({
  dataDir,
  home,
  scratch,
  plan,
  includeHistory,
  withCredentials,
}) {
  const accounts = readJson(path.join(dataDir, "accounts.json"), []).filter(
    (account) =>
      account?.kind === "managed" &&
      typeof account.id === "string" &&
      segment.test(account.id) &&
      Object.hasOwn(nativeRoots, account.tool),
  );
  const result = { files: [], credentials: [], captures: [], omissions: [] };
  const present = accounts.filter((account) =>
    fs.existsSync(path.join(dataDir, "profiles", account.id)),
  );
  if (!present.length) return result;
  result.omissions.push(profileOmissions.unlisted);
  if (!includeHistory) result.omissions.push(profileOmissions.history);
  else if (!withCredentials) result.omissions.push(profileOmissions.unsealed);
  // CLI history is sealed with a key from the capsule, so it needs credentials.
  const history = includeHistory && withCredentials;
  if (!withCredentials) return result;
  const shared = sharedAssetLinks(dataDir, home);
  let skipped = false,
    sealedBytes = 0;
  for (const account of present) {
    const component = profileComponent(account);
    const prefix = `profiles/${account.id}`;
    const base = path.join(dataDir, prefix);
    let profileBytes = 0;
    const seal = (name, file) => {
      const bytes = readFile(file);
      profileBytes += bytes.length;
      sealedBytes += bytes.length;
      if (profileBytes > PROFILE_CREDENTIAL_LIMIT || sealedBytes > CREDENTIAL_LIMIT)
        throw problem(
          serverMessages.backups.profileCredentialLimit(
            account.name,
            toolNames[account.tool],
            formatBytes(PROFILE_CREDENTIAL_LIMIT),
          ),
          413,
        );
      result.credentials.push(fileMember(name, bytes));
    };
    const secret = path.join(base, "secret.json");
    const secretStat = fs.lstatSync(secret, { throwIfNoEntry: false });
    if (withCredentials && secretStat) {
      if (secretStat.isFile() && secretStat.nlink === 1)
        seal(`${prefix}/secret.json`, secret);
      else skipped = true;
    }
    const visit = async (root, directory, relative) => {
      for (const name of fs.readdirSync(directory).sort()) {
        const file = path.join(directory, name);
        const next = relative ? `${relative}/${name}` : name;
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) {
          // Links that sharing created point at the user's own CLI folder.
          if (!shared.has(file)) skipped = true;
          continue;
        }
        if (stat.isDirectory()) {
          if (descend(root, next)) await visit(root, file, next);
          continue;
        }
        const kind = classify(root, next);
        if (!kind || (kind !== "credentials" && !history)) continue;
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          (process.getuid && stat.uid !== process.getuid())
        ) {
          skipped = true;
          continue;
        }
        const member = `${prefix}/${path.relative(base, file).split(path.sep).join("/")}`;
        if (kind === "credentials") seal(member, file);
        else if (kind === "history") {
          const planned = plan.file(member, file, component, stat);
          if (planned) result.files.push({ ...planned, history: true });
        } else {
          // A live database is copied consistently; the copy is what is archived.
          ensureSpace(scratch, stat.size);
          const startedAt = new Date().toISOString();
          const copy = await sqliteSnapshotFileAsync(file, scratch);
          result.files.push({
            path: member,
            file: copy,
            size: fs.statSync(copy).size,
            component,
            history: true,
          });
          // The public manifest does not name sealed history files.
          result.captures.push({
            component: "cli-history-database",
            startedAt,
            finishedAt: new Date().toISOString(),
            consistency: "sqlite-snapshot",
          });
        }
      }
    };
    for (const folder of profileBases(base))
      for (const root of nativeRoots[account.tool]) {
        const directory = path.join(folder, root);
        const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
        if (stat?.isDirectory()) await visit(root, directory, "");
        else if (stat?.isSymbolicLink()) skipped = true;
      }
  }
  if (skipped) result.omissions.push(profileOmissions.linked);
  return result;
}
