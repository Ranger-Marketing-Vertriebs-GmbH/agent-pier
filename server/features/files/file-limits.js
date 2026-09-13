import { fileProblem } from "./file-errors.js";

export const defaultFileLimits = Object.freeze({
  listPageSize: 200,
  listEntries: 100000,
  searchEntries: 100000,
  searchResults: 10000,
  searchMs: 30000,
  textBytes: 2 * 1024 ** 2,
  imageBytes: 20 * 1024 ** 2,
  uploadBytes: 10 * 1024 ** 3,
  jobBytes: 50 * 1024 ** 3,
  jobEntries: 50000,
  maxDepth: 128,
  transfers: 3,
  jobsRetentionMs: 7 * 86400000,
  uploadRetentionMs: 86400000,
});

export function readFileLimits(overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
    throw fileProblem("FILE_INVALID_LIMITS", 400);
  const limits = { ...defaultFileLimits };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value <= 0)
      throw fileProblem("FILE_INVALID_LIMITS", 400);
    limits[key] = value;
  }
  return limits;
}
