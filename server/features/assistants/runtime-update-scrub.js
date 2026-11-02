import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  isConfigFile,
  isCredentialFile,
  readBackupKey,
  seal,
  sealedSuffix,
  unseal,
} from "./backup-credentials.js";
import { digestTree, durablePrivate } from "./runtime-update-snapshot.js";

// When a ChatGPT login moves from OpenClaw to AgentPier (model-account-move.js), the
// update snapshots taken before still hold OpenClaw's copy of its refresh token,
// sealed with each snapshot's own key. A rollback to one of them would bring back a
// second refresher. Destroying the keys would lose every snapshot's credentials and
// so the rollback itself; instead each snapshot is rewritten: the sealed credential
// rows are unsealed, the profile loses its refresh token, and they are sealed again
// with the same key and context, the manifest's digest following. A sealed part that
// cannot be rewritten safely (unknown shape) is kept but listed in the manifest's
// `withheldSealed`: a restore leaves its credentials out (restoreUpdateSnapshot), and
// AgentPier writes its access-only profile again before the next Gateway start.

const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);

// A store JSON text without the profile's refresh token (or, with `remove`, without
// the profile): `{ text, changed }`, or null when the text is no store AgentPier
// understands.
function scrubStore(text, profileId, remove) {
  let store;
  try {
    store = JSON.parse(text);
  } catch {
    return null;
  }
  if (!record(store) || !record(store.profiles)) return null;
  const profile = store.profiles[profileId];
  if (profile === undefined) return { text, changed: false };
  if (!record(profile)) return null;
  if (remove) {
    const { [profileId]: _gone, ...profiles } = store.profiles;
    return { text: JSON.stringify({ ...store, profiles }), changed: true };
  }
  if (profile.refresh === undefined && profile.authFlow === undefined)
    return { text, changed: false };
  const { refresh: _refresh, authFlow: _flow, ...rest } = profile;
  return {
    text: JSON.stringify({
      ...store,
      profiles: { ...store.profiles, [profileId]: rest },
    }),
    changed: true,
  };
}

// The store cells a database dump can hold (openclaw-access-profiles.js layouts).
function scrubDump(dump, profileId, remove) {
  let changed = false;
  const cells = [
    ["auth_profile_store", "store_json", () => true],
    [
      "config_machine_state",
      "value_json",
      (row) => row.state_key === "authProfiles.store",
    ],
  ];
  for (const [table, column, holds] of cells)
    for (const row of Array.isArray(dump[table]) ? dump[table] : []) {
      if (!holds(row) || typeof row[column] !== "string") continue;
      const result = scrubStore(row[column], profileId, remove);
      if (!result) return null;
      if (result.changed) {
        row[column] = result.text;
        changed = true;
      }
    }
  return { dump, changed };
}

/**
 * Rewrites every update snapshot under `root/backups` so none holds a refresh token
 * of `profileId` (`remove`: none holds the profile at all, after a logout). Returns `{ scrubbed, withheld }`: the snapshot ids rewritten and
 * the parts marked withheld. A snapshot without its key holds no usable credential.
 */
export async function scrubBackupProfile(root, profileId, { remove = false } = {}) {
  const folder = path.join(root, "backups");
  const result = { scrubbed: [], withheld: [] };
  const names = fs.existsSync(folder) ? fs.readdirSync(folder).sort() : [];
  for (const id of names) {
    const directory = path.join(folder, id);
    const manifestFile = path.join(directory, "snapshot.json");
    if (!fs.existsSync(manifestFile)) continue;
    let key;
    try {
      key = readBackupKey(root, id);
    } catch {
      key = null;
    }
    if (!key) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    const payload = path.join(directory, "payload");
    const excluded = new Set(manifest.excludedLinks || []);
    // A snapshot that no longer matches its digest cannot be restored anyway.
    if (manifest.digest !== (await digestTree(payload, excluded))) continue;
    const withheld = new Set(manifest.withheldSealed || []);
    let changed = false;
    for (const relative of manifest.sealed || []) {
      // Configuration copies seal secret members only, never an auth profile.
      if (isConfigFile(relative) || withheld.has(relative)) continue;
      const sidecar = path.join(payload, relative + sealedSuffix);
      if (!fs.existsSync(sidecar)) continue;
      const aad = `${id}\0${relative}`;
      let next = null;
      try {
        const plain = unseal(key, aad, await fsp.readFile(sidecar)).toString();
        if (isCredentialFile(relative)) {
          const scrubbed = scrubStore(plain, profileId, remove);
          next = scrubbed && { changed: scrubbed.changed, text: scrubbed.text };
        } else {
          const scrubbed = scrubDump(JSON.parse(plain), profileId, remove);
          next = scrubbed && {
            changed: scrubbed.changed,
            text: JSON.stringify(scrubbed.dump),
          };
        }
      } catch {
        next = null;
      }
      if (!next) {
        // Only a part that may hold the profile is withheld: legacy JSON files and
        // databases whose dump AgentPier cannot read.
        withheld.add(relative);
        result.withheld.push(`${id}/${relative}`);
        changed = true;
        continue;
      }
      if (!next.changed) continue;
      const temporary = `${sidecar}.scrub`;
      await fsp.writeFile(temporary, seal(key, aad, Buffer.from(next.text)), {
        mode: 0o600,
        flag: "wx",
      });
      await fsp.rename(temporary, sidecar);
      changed = true;
    }
    if (!changed) continue;
    manifest.withheldSealed = [...withheld].sort();
    manifest.digest = await digestTree(payload, excluded);
    durablePrivate(manifestFile, manifest);
    result.scrubbed.push(id);
  }
  return result;
}
