import { Router } from "express";

/**
 * The owner's Android devices (features/devices/device-service.js) and the
 * installation of their SDK (android-sdk.js). Owner only, as every route outside
 * /api/me (route-access.js), and never cached. The same values reach the browser
 * over the live topics `devices` and `devices.installation`.
 *
 * A refusal with a stable code answers `{ code, error: code }` with its status and
 * the detail the error carries (`reason`, `image`, `exitCode`); the web app has a
 * text for every code. Anything else goes to the error handler.
 *
 * `start` and `stop` answer 202 with the device as it is then, and the topic follows:
 * a start answers once the device holds a running slot (state `starting`) or was
 * refused, so a refusal that leaves no trace in the device's state (the limit, an
 * unavailable host) is never lost; what goes wrong later is the device's `failure`.
 * `reset` and `DELETE` answer when they are done. A stop, a reset and a delete end
 * a boot in progress instead of waiting for it.
 *
 * While the installation is removed with every device, each of these routes and
 * `POST /devices` answers DEVICE_UNAVAILABLE with `reason`
 * DEVICES_OPERATION_RUNNING; the removal itself is refused with DEVICES_IN_USE while
 * a device starts, runs or stops and with DEVICE_BUSY while one is reset or deleted
 * or has calls waiting.
 */
const owner = Object.freeze({ kind: "owner" });
const stable = /^DEVICES?_[A-Z0-9_]+$/;
const details = ["reason", "image", "exitCode"];
const record = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value) ? value : {};
const refusal = (code, status = 409) => Object.assign(Error(code), { code, status });

function refuse(res, error) {
  if (!stable.test(error?.code || "")) throw error;
  const { code } = error;
  const body = { code, error: code };
  for (const name of details)
    if (["string", "number"].includes(typeof error[name])) body[name] = error[name];
  res.status([400, 403, 404, 409].includes(error.status) ? error.status : 409).json(body);
}
// A handler whose stable refusals are answered as such.
const answering = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    refuse(res, error);
  }
};

/**
 * Resolves once `pending` settled or `reached()` holds, whichever is first; a
 * rejection of `pending` before that is thrown, a later one shows in the device's
 * state.
 */
async function early(devices, pending, reached) {
  const holds = () => {
    try {
      return reached();
    } catch {
      return false;
    }
  };
  let stop = () => {};
  const changed = new Promise((resolve) => {
    stop = devices.onChanged(() => holds() && resolve());
  });
  try {
    // What is refused before anything waits is known after this turn's microtasks.
    await Promise.race([pending, new Promise((resolve) => setImmediate(resolve))]);
    if (!holds()) await Promise.race([pending, changed]);
  } finally {
    stop();
  }
}

export function devicesRoutes(services) {
  const devices = () => services.devices;
  const sdk = () => services.androidSdk;
  const router = Router();
  router.use("/devices", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.get("/devices/installation", (_req, res) => res.json(sdk().status()));
  router.post(
    "/devices/installation/install",
    answering((req, res) => {
      res.status(202).json(sdk().install({ acceptTerms: record(req.body).acceptTerms }));
    }),
  );
  router.post("/devices/installation/cancel", (_req, res) =>
    res.status(202).json(sdk().cancel()),
  );
  // Removing the installation deletes every device first; nothing goes while a
  // device runs, is reset or deleted or has calls waiting, or while another job
  // works on the SDK.
  router.post(
    "/devices/installation/remove",
    answering(async (_req, res) => {
      if (sdk().operation) throw refusal("DEVICES_OPERATION_RUNNING");
      await devices().removeAll();
      res.status(202).json(sdk().remove());
    }),
  );

  router.get("/devices", (_req, res) => res.json(devices().view()));
  router.put(
    "/devices/settings",
    answering((req, res) => {
      const { maxDevices, maxRunning } = record(req.body);
      res.json(devices().configure({ maxDevices, maxRunning }));
    }),
  );
  router.post(
    "/devices",
    answering(async (req, res) => {
      const creator = { kind: "owner", id: "owner", name: "" };
      res
        .status(201)
        .json(await devices().create({ name: record(req.body).name, creator }));
    }),
  );
  router.post(
    "/devices/:id/start",
    answering(async (req, res) => {
      const { id } = req.params;
      const pending = devices().startDevice(id, { caller: owner });
      // The boot goes on after the answer; its failure is the device's `failure`.
      pending.catch(() => {});
      await early(devices(), pending, () =>
        ["starting", "running"].includes(devices().device(id).state),
      );
      res.status(202).json(devices().device(id));
    }),
  );
  router.post(
    "/devices/:id/stop",
    answering(async (req, res) => {
      const { id } = req.params;
      const pending = devices().stopDevice(id, { caller: owner });
      pending.catch(() => {});
      // A refusal is known at once; a stop that fails later shows as `failure`.
      await Promise.race([pending, new Promise((resolve) => setImmediate(resolve))]);
      res.status(202).json(devices().device(id));
    }),
  );
  router.post(
    "/devices/:id/reset",
    answering(async (req, res) => {
      res.status(202).json(await devices().reset(req.params.id, { caller: owner }));
    }),
  );
  router.delete(
    "/devices/:id",
    answering(async (req, res) => {
      await devices().remove(req.params.id, { caller: owner });
      res.status(204).end();
    }),
  );
  return router;
}
