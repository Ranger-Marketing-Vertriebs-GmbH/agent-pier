import fs from "node:fs";
import path from "node:path";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { validCredential } from "../login/passwords.js";
import { problem } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { UserStore } from "./user-store.js";

/**
 * Users in backups (docs/backups.md): the public member lists the users without their
 * password salt and hash; those travel only in the encrypted credentials capsule.
 * Sessions are never archived, so every restored user signs in again.
 */
export const usersMember = "users/users.json";
export const userCredentialsMember = "users/credentials.json";

const usersFile = (dataDir) => path.join(dataDir, usersMember);

/** Whether this data folder holds users at all. */
export const usersPresent = (dataDir) => fs.existsSync(usersFile(dataDir));

/**
 * The public users list and, with `withCredentials`, the password records for the
 * capsule, as `{ users, credentials }` values; null without a user store.
 */
export function captureUsers(dataDir, withCredentials) {
  if (!usersPresent(dataDir)) return null;
  const data = readJSON(usersFile(dataDir), null);
  if (!Array.isArray(data?.users)) return null;
  const users = data.users.map(({ salt: _salt, hash: _hash, ...user }) => user);
  const passwords = Object.create(null);
  for (const user of data.users)
    if (validCredential(user)) passwords[user.id] = { salt: user.salt, hash: user.hash };
  return {
    users: { version: 1, users },
    credentials: withCredentials ? { version: 1, passwords } : null,
  };
}

/**
 * Rebuilds the user store in a restore `stage` from the public list and, when the
 * capsule came along, the password records. A user without one keeps her agents and
 * settings (her chats are only in sealed backups, which always carry the capsule) but
 * cannot sign in until the owner sets a new password (`mustReset`).
 * Returns the display names of those users.
 */
export function restoreUsers(stage) {
  const file = usersFile(stage);
  if (!fs.existsSync(file)) return [];
  const listed = readJSON(file, null);
  const secrets = path.join(stage, userCredentialsMember);
  const passwords = readJSON(secrets, null)?.passwords || {};
  fs.rmSync(secrets, { force: true });
  if (!Array.isArray(listed?.users))
    throw problem(serverMessages.backups.unexpectedComponent);
  const needingReset = [];
  const users = listed.users.map(
    ({ salt: _salt, hash: _hash, mustReset: _m, ...user }) => {
      const credential = Object.hasOwn(passwords, user.id) ? passwords[user.id] : null;
      if (validCredential(credential))
        return { ...user, salt: credential.salt, hash: credential.hash };
      needingReset.push(user.displayName);
      return { ...user, mustReset: true };
    },
  );
  writePrivate(file, { version: 1, users, sessions: [] });
  // The restored folder must start: a store the server would refuse fails the restore.
  try {
    new UserStore({ dataDir: stage });
  } catch {
    throw problem(serverMessages.backups.unexpectedComponent);
  }
  return needingReset;
}
