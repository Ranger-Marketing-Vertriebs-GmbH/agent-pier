import { fileProblem } from "../features/files/file-errors.js";
import { filesCopy } from "../lib/i18n/de/files.js";

function issueArgs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) =>
      ["string", "number", "boolean"].includes(typeof item),
    ),
  );
}

export function fileHandler(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (res.headersSent || res.destroyed) {
        if (!res.destroyed) res.destroy();
        return;
      }
      const stable = /^FILE_[A-Z0-9_]+$/.test(error.code || "");
      const status =
        stable &&
        Number.isInteger(error.status) &&
        error.status >= 400 &&
        error.status <= 599
          ? error.status
          : 500;
      res.status(status).json({
        error: filesCopy.explorerFailed,
        code: stable ? error.code : "FILE_IO_ERROR",
        args: stable ? issueArgs(error.args) : {},
      });
    }
  };
}

export function openedScope(req, scope) {
  if (req.get("X-File-Scope") !== scope.id) throw fileProblem("FILE_INVALID_SCOPE", 409);
}
