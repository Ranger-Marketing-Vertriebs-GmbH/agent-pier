import { z } from "zod";
import { artifactError, artifactLimits } from "./artifact-errors.js";
import { safeBundlePath } from "./artifact-source.js";
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
const uuid = z.uuid();
const summary = z.object({
  id: uuid,
  projectId: identity,
  sessionId: identity,
  title: z.string().min(1).max(100),
  mediaType: z.string().max(100),
  sizeBytes: z.number().int().min(0).max(artifactLimits.publicationBytes),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  pinned: z.boolean(),
});
const manifest = summary
  .extend({
    generation: uuid,
    entrypoint: z.string().refine(safeBundlePath),
    files: z
      .array(
        z.strictObject({
          path: z.string().refine(safeBundlePath),
          mediaType: z.string().regex(/^(?:image|font|text|application)\/[a-z0-9+.-]+$/),
          size: z.number().int().min(0).max(artifactLimits.publicationBytes),
          stored: z.string().regex(/^\d{1,3}$/),
        }),
      )
      .min(1)
      .max(500),
  })
  .strict();
const stateSchema = z.strictObject({
  version: z.literal(1),
  records: z.record(
    uuid,
    z.union([
      manifest,
      z.strictObject({ id: uuid, sessionId: identity, deleted: z.literal(true) }),
    ]),
  ),
  receipts: z.record(
    z.string().max(161),
    z.strictObject({
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      result: summary.extend({ orphaned: z.boolean() }).strict(),
    }),
  ),
  retired: z.array(identity),
});
export function validateArtifactState(input) {
  const parsed = stateSchema.safeParse(input);
  if (!parsed.success) throw artifactError("ARTIFACT_IO_ERROR", 500);
  const state = parsed.data;
  if (
    Object.keys(state.receipts).length > 10000 ||
    Object.keys(state.records).length > 10000
  )
    throw artifactError("ARTIFACT_IO_ERROR", 500);
  for (const [id, row] of Object.entries(state.records)) {
    if (row.id !== id) throw artifactError("ARTIFACT_IO_ERROR", 500);
    if (row.deleted) continue;
    if (
      new Set(row.files.map((file) => file.stored)).size !== row.files.length ||
      new Set(row.files.map((file) => file.path.toLowerCase())).size !==
        row.files.length ||
      row.files.reduce((sum, file) => sum + file.size, 0) !== row.sizeBytes ||
      !row.files.some(
        (file) => file.path === row.entrypoint && file.mediaType === row.mediaType,
      )
    )
      throw artifactError("ARTIFACT_IO_ERROR", 500);
  }
  return state;
}
