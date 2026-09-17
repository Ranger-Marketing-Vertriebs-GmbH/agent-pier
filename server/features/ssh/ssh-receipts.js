import { createHash } from "node:crypto";
import { sshProblem } from "./ssh-errors.js";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export const sshDigest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const identity = (row) =>
  row.host
    ? sshDigest([row.host, row.port, row.username, row.keyId, row.hostKey])
    : sshDigest(row.publicKey);

export function requestReceipt(catalog, { projectId, operation, requestId, input }) {
  if (
    typeof requestId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(requestId)
  )
    throw sshProblem("SSH_INVALID_ARGUMENT", "A bounded request ID is required.");
  const receipt = catalog
    .read()
    .receipts.find(
      (row) =>
        row.projectId === projectId &&
        row.operation === operation &&
        row.requestId === requestId,
    );
  if (receipt && receipt.digest !== sshDigest(input))
    throw sshProblem(
      "SSH_REQUEST_CONFLICT",
      "Request ID was already used with different arguments.",
      409,
    );
  return receipt;
}

export function saveReceipt(catalog, context, resource) {
  catalog.replacePart("receipts", [
    ...catalog.read().receipts,
    {
      projectId: context.projectId,
      operation: context.operation,
      requestId: context.requestId,
      digest: sshDigest(context.input),
      resourceId: resource.id,
      identity: identity(resource),
      tombstone: false,
    },
  ]);
}

export function replayReceipt(receipt, resolve) {
  let resource;
  try {
    if (!receipt.tombstone) resource = resolve(receipt.resourceId);
  } catch {
    /* Gone. */
  }
  if (!resource || resource.projectId !== receipt.projectId)
    throw sshProblem(
      "SSH_REQUEST_RESOURCE_GONE",
      "The original request resource was deleted or moved.",
      409,
    );
  if (identity(resource) !== receipt.identity)
    throw sshProblem(
      "SSH_REQUEST_CONFLICT",
      "The original connection was changed in the UI.",
      409,
    );
  return resource;
}
