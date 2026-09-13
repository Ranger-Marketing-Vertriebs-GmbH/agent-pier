import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { privateDirectory, readJSON, writePrivate } from "../../lib/storage.js";
import { fileProblem, fileSystemProblem } from "./file-errors.js";

const emptyHost = () => ({ showHidden: false, favorites: [] });

function preferenceProblem() {
  return fileProblem("FILE_INVALID_PREFERENCES", 400);
}

function validSelectedPath(scope, value) {
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
    !validSelectedPath(scope, value.path)
  )
    throw preferenceProblem();
  return { id: value.id, name: value.name.trim(), path: value.path };
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function admittedProjectPath(scope, absolute) {
  if (!isWithin(scope.root, absolute)) return false;
  try {
    return isWithin(scope.root, fs.realpathSync(absolute));
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(error.code))
      return true;
    throw error;
  }
}

function projectFavorite(scope, value) {
  const stored = favorite({ kind: "global" }, value);
  if (!admittedProjectPath(scope, stored.path)) return null;
  const relative = path.relative(scope.root, stored.path).split(path.sep).join("/");
  return { ...stored, path: relative };
}

function hostFavorite(scope, value) {
  const visible = favorite(scope, value);
  if (scope.kind === "global") return visible;
  const absolute = path.join(scope.root, visible.path);
  if (!admittedProjectPath(scope, absolute)) throw preferenceProblem();
  return { ...visible, path: absolute };
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
      !Array.isArray(value.favorites)
    )
      throw preferenceProblem();
    return value;
  }

  get(scope) {
    const host = this.host();
    return {
      favorites:
        scope.kind === "global"
          ? host.favorites.map((value) => favorite(scope, value))
          : host.favorites.map((value) => projectFavorite(scope, value)).filter(Boolean),
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
        favorites: current.favorites,
      };
      if (Object.hasOwn(patch, "favorites")) {
        const favorites = patch.favorites.map((value) => hostFavorite(scope, value));
        let combined = favorites;
        if (scope.kind === "project") {
          const visible = current.favorites.map((value) => projectFavorite(scope, value));
          const firstVisible = visible.findIndex(Boolean);
          const outside = current.favorites.filter((_, index) => !visible[index]);
          const insertion =
            firstVisible < 0
              ? outside.length
              : current.favorites
                  .slice(0, firstVisible)
                  .filter((_, index) => !visible[index]).length;
          combined = [
            ...outside.slice(0, insertion),
            ...favorites,
            ...outside.slice(insertion),
          ];
        }
        if (new Set(combined.map((value) => value.id)).size !== combined.length)
          throw preferenceProblem();
        next.favorites = combined;
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
