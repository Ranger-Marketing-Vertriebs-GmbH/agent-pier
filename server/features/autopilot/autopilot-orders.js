import { randomUUID } from "node:crypto";
import { nameValue } from "../../lib/storage.js";
import { gitRef } from "../pipelines/workspace-git.js";
import { orderError } from "./order-error.js";
import { checkSelection } from "./order-resources.js";

function fields(input, allowed) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.includes(key))
  )
    throw orderError("invalidOrder", 400);
}

function policies(input) {
  const result = {};
  for (const key of ["allowMerge", "implementationAuthorized"]) {
    if (!(key in input)) continue;
    if (typeof input[key] !== "boolean") throw orderError("invalidOrder", 400);
    result[key] = input[key];
  }
  return result;
}

function writable({ ref, document, limitations }) {
  if (ref.cleanup) throw orderError("inactive");
  if (!document || limitations.includes("identityMismatch"))
    throw orderError("orderFileUnavailable");
}

function active(record) {
  writable(record);
  if (!record.ref.managed) throw orderError("unmanaged");
  if (record.document.status === "completed") throw orderError("inactive");
}

export class AutopilotOrders {
  constructor({ store, resources, view }) {
    Object.assign(this, { store, resources, view });
    this.writes = new Map();
  }

  // Serialize the entire transition, including its external effects. Reads and other
  // orders in this repository stay available while a CLI or Git is starting.
  async write(id, action) {
    const next = (this.writes.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => action(await this.store.get(id)));
    this.writes.set(id, next);
    try {
      return await next;
    } finally {
      if (this.writes.get(id) === next) this.writes.delete(id);
    }
  }

  context({ ref, document }) {
    return {
      id: ref.id,
      projectRoot: ref.projectRoot,
      commonDir: ref.commonDir,
      filename: ref.filename,
      title:
        typeof document?.title === "string" && document.title.trim()
          ? document.title.trim()
          : ref.id,
      baseBranch: ref.baseBranch,
      selection: ref.selection,
      resources: ref.resources ?? {},
      resumeId: ref.resumeId,
      cleanup: ref.cleanup,
      saveResources: (resources) => this.store.setReference(ref.id, { resources }),
    };
  }

  async present(record, options) {
    const session =
      record.ref.managed &&
      record.ref.resources?.sessionId &&
      !record.limitations.includes("projectUnavailable")
        ? await this.resources.inspectSession(this.context(record))
        : null;
    return this.view({ ...record, session }, options);
  }

  async list() {
    const records = await this.store.list();
    return { orders: await Promise.all(records.map((record) => this.present(record))) };
  }

  async get(id, options) {
    return this.present(await this.store.get(id), options);
  }

  async create(input) {
    fields(input, [
      "projectId",
      "requestId",
      "title",
      "brief",
      "baseBranch",
      "session",
      "allowMerge",
      "implementationAuthorized",
    ]);
    if (
      typeof input.projectId !== "string" ||
      !input.projectId ||
      typeof input.requestId !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.requestId) ||
      typeof input.brief !== "string" ||
      !input.brief.trim() ||
      Buffer.byteLength(input.brief) > 65536
    )
      throw orderError("invalidOrder", 400);
    const initial = {
      requestId: input.requestId,
      title: nameValue(input.title),
      brief: input.brief.trim(),
      status: "draft",
      planStatus: "draft",
      batches: [],
      draftBatches: [],
      manualPaused: false,
      allowMerge: false,
      implementationAuthorized: false,
      ...policies(input),
    };
    const { ref } = await this.store.create(input.projectId, initial, {
      selection: checkSelection(input.session),
      baseBranch: input.baseBranch === undefined ? null : gitRef(input.baseBranch),
    });
    try {
      return await this.write(ref.id, async (record) => {
        if (
          !record.ref.started &&
          !record.ref.cleanup &&
          !record.document?.manualPaused &&
          record.document?.status !== "completed"
        ) {
          active(record);
          await this.resources.start(this.context(record), {});
          await this.store.setReference(ref.id, { started: true });
        }
        return this.get(ref.id);
      });
    } catch (error) {
      throw Object.assign(error, { orderId: ref.id, autopilotStart: true });
    }
  }

  policy(id, input) {
    fields(input, ["allowMerge", "implementationAuthorized"]);
    const patch = policies(input);
    if (!Object.keys(patch).length) throw orderError("invalidOrder", 400);
    return this.write(id, async (record) => {
      writable(record);
      await this.store.update(id, (doc) => ({ ...doc, ...patch }));
      return this.get(id);
    });
  }

  pause(id) {
    return this.write(id, async (record) => {
      active(record);
      await this.store.update(id, (doc) => ({ ...doc, manualPaused: true }));
      if (record.ref.resumeId) await this.store.setReference(id, { resumeId: null });
      return this.get(id);
    });
  }

  resume(id, input) {
    fields(input, ["recover", "session"]);
    if (input.recover !== undefined && typeof input.recover !== "boolean")
      throw orderError("invalidOrder", 400);
    return this.write(id, async (record) => {
      active(record);
      if (input.session !== undefined) {
        // Only an initial or explicitly recovered missing session can choose a profile.
        if (
          record.ref.resources?.sessionId &&
          ((record.ref.resources.sessionConfirmed && !input.recover) ||
            (await this.resources.inspectSession(this.context(record))))
        )
          throw orderError("invalidOrder", 400);
        await this.store.setReference(id, { selection: checkSelection(input.session) });
      }
      if (record.document.manualPaused) {
        // Save before unpausing. A retry sends the same durable delivery ID after a crash.
        if (!record.ref.resumeId)
          await this.store.setReference(id, { resumeId: randomUUID() });
        await this.store.update(id, (doc) => ({ ...doc, manualPaused: false }));
      }
      const ctx = this.context(await this.store.get(id));
      try {
        await this.resources.start(ctx, {
          recover: input.recover === true,
          notify: !!ctx.resumeId,
        });
      } catch (error) {
        // Leave a failed resume paused. Keep its delivery ID so retrying an
        // ambiguous handoff cannot duplicate a message in the same session.
        if (ctx.resumeId)
          await this.store.update(id, (doc) => ({ ...doc, manualPaused: true }));
        throw error;
      }
      await this.store.setReference(id, { started: true, resumeId: null });
      return this.get(id);
    });
  }

  remove(id) {
    return this.write(id, async (record) => {
      if (!record.ref.managed) throw orderError("cleanupUnavailable");
      if (record.limitations.includes("projectUnavailable"))
        throw orderError("projectUnavailable");
      if (!record.ref.cleanup) {
        writable(record);
        if (
          record.document.status !== "completed" ||
          (await this.present(record, { remote: true })).hasOpenWork
        )
          throw orderError("cleanupUnavailable");
      }
      await this.resources.cleanup(this.context(record), {
        begin: async () => {
          if (!record.ref.cleanup) {
            const latest = await this.store.get(id);
            if (latest.document?.status !== "completed")
              throw orderError("cleanupUnavailable");
            await this.store.setReference(id, { cleanup: true });
          }
        },
      });
      await this.store.remove(id);
    });
  }
}
