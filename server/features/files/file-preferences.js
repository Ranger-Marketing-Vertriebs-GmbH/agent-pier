import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { privateDirectory, readJSON, writePrivate } from "../../lib/storage.js";
import { fileProblem, fileSystemProblem } from "./file-errors.js";

const emptyHost = () => ({ showHidden: false, scopes: {} });

function preferenceProblem() {
  return fileProblem("FILE_INVALID_PREFERENCES", 400);
}

function validPath(scope, value) {
  if (typeof value !== "string" || value.length > 4096 || /\p{Cc}/u.test(value))
    return false;
  if (scope.kind === "global") return path.isAbsolute(value);
  return (
    !path.isAbsolute(value) &&
    !value.split("/").some((part) => part === "..") &&
    value !== "~" &&
    !value.startsWith("~/")
  );
}

function favorite(scope, value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["id", "name", "path"].includes(key)) ||
    typeof value.id !== "string" ||
    !value.id ||
    value.id.length > 100 ||
    /\p{Cc}/u.test(value.id) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 255 ||
    /\p{Cc}/u.test(value.name) ||
    !validPath(scope, value.path)
  )
    throw preferenceProblem();
  return { id: value.id, name: value.name.trim(), path: value.path };
}

function validateSaved(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.version !== 1 ||
    !value.hosts ||
    typeof value.hosts !== "object" ||
    Array.isArray(value.hosts)
  )
    throw preferenceProblem();
  return value;
}

export class FilePreferences {
  constructor({ dataDir, home }) {
    try {
      const canonicalData = fs.realpathSync(privateDirectory(path.resolve(dataDir)));
      const canonicalHome = fs.realpathSync(path.resolve(home));
      this.file = path.join(canonicalData, "files", "preferences.json");
      this.hostId = createHash("sha256")
        .update(JSON.stringify([canonicalHome, canonicalData]))
        .digest("hex");
      const saved = readJSON(this.file, null);
      this.value = saved === null ? { version: 1, hosts: {} } : validateSaved(saved);
    } catch (error) {
      throw fileSystemProblem(error);
    }
  }

  host() {
    const value = this.value.hosts[this.hostId];
    if (!value) return emptyHost();
    if (
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof value.showHidden !== "boolean" ||
      !value.scopes ||
      typeof value.scopes !== "object" ||
      Array.isArray(value.scopes)
    )
      throw preferenceProblem();
    return value;
  }

  get(scope) {
    const host = this.host();
    const values = host.scopes[scope.id] || [];
    if (!Array.isArray(values)) throw preferenceProblem();
    return {
      favorites: values.map((value) => favorite(scope, value)),
      showHidden: host.showHidden,
    };
  }

  update(scope, patch) {
    try {
      if (
        !patch ||
        typeof patch !== "object" ||
        Array.isArray(patch) ||
        Object.keys(patch).length === 0 ||
        Object.keys(patch).some((key) => !["favorites", "showHidden"].includes(key)) ||
        (Object.hasOwn(patch, "showHidden") && typeof patch.showHidden !== "boolean") ||
        (Object.hasOwn(patch, "favorites") && !Array.isArray(patch.favorites))
      )
        throw preferenceProblem();
      const current = this.host();
      const next = {
        showHidden: Object.hasOwn(patch, "showHidden")
          ? patch.showHidden
          : current.showHidden,
        scopes: { ...current.scopes },
      };
      if (Object.hasOwn(patch, "favorites")) {
        const favorites = patch.favorites.map((value) => favorite(scope, value));
        if (new Set(favorites.map((value) => value.id)).size !== favorites.length)
          throw preferenceProblem();
        next.scopes[scope.id] = favorites;
      }
      const value = {
        ...this.value,
        hosts: { ...this.value.hosts, [this.hostId]: next },
      };
      writePrivate(this.file, value);
      this.value = value;
      return this.get(scope);
    } catch (error) {
      throw fileSystemProblem(error);
    }
  }
}
