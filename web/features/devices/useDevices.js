import { useCallback, useEffect, useRef, useState } from "react";
import api from "../../lib/api.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { refusalText, validDevices, validInstallation } from "./device-view.js";

// A refusal in words (device-view.js), with the code kept for callers that branch.
const worded = (error) =>
  Object.assign(Error(refusalText(error)), { code: error?.code, status: error?.status });

/**
 * The owner's Android devices and the installation of their components: both follow
 * their live topics (`devices`, `devices.installation`), so a boot, a download step or
 * a change made elsewhere shows without a request. The actions send one request each
 * and resolve once its result shows; they reject with the refusal in words.
 *
 * `pending` holds the keys of the requests that are running (`install`, `cancel`,
 * `remove`, `create`, `start:<id>`, `stop:<id>`, `reset:<id>`, `delete:<id>`): a
 * control stays disabled from its click until the answer, and a second click on it
 * sends nothing (`start` and `reset` answer only when the device holds its slot or
 * the reset is done).
 */
export default function useDevices() {
  const devices = useLiveTopic("devices");
  const installation = useLiveTopic("devices.installation");
  const [pending, setPending] = useState(() => new Set());
  // The lock is synchronous: two clicks in one frame see it before React renders.
  const locks = useRef(new Set());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const refreshDevices = devices.refresh;
  const refreshInstallation = installation.refresh;
  const run = useCallback(
    async (key, request, { both = false } = {}) => {
      if (locks.current.has(key)) return undefined;
      locks.current.add(key);
      setPending(new Set(locks.current));
      try {
        const answer = await request();
        // The result shows before the control is free again.
        await Promise.all([refreshDevices(), both && refreshInstallation()]);
        return answer;
      } catch (error) {
        // What changed elsewhere shows before the refusal is read.
        await Promise.all([refreshDevices(), refreshInstallation()]).catch(() => {});
        throw worded(error);
      } finally {
        locks.current.delete(key);
        if (alive.current) setPending(new Set(locks.current));
      }
    },
    [refreshDevices, refreshInstallation],
  );
  const device = (id) => `/devices/${encodeURIComponent(id)}`;
  return {
    view: validDevices(devices.data) ? devices.data : null,
    status: validInstallation(installation.data) ? installation.data : null,
    loading: devices.loading || installation.loading,
    error: devices.error || installation.error,
    pending,
    refresh: refreshDevices,
    install: () =>
      run(
        "install",
        () => api("/devices/installation/install", "POST", { acceptTerms: true }),
        { both: true },
      ),
    cancel: () =>
      run("cancel", () => api("/devices/installation/cancel", "POST"), { both: true }),
    remove: () =>
      run("remove", () => api("/devices/installation/remove", "POST"), { both: true }),
    create: (name) => run("create", () => api("/devices", "POST", { name })),
    start: (id) => run(`start:${id}`, () => api(`${device(id)}/start`, "POST")),
    stop: (id) => run(`stop:${id}`, () => api(`${device(id)}/stop`, "POST")),
    reset: (id) => run(`reset:${id}`, () => api(`${device(id)}/reset`, "POST")),
    delete: (id) => run(`delete:${id}`, () => api(device(id), "DELETE")),
    saveLimits: async (limits) => {
      try {
        const saved = await api("/devices/settings", "PUT", limits);
        await refreshDevices();
        return saved;
      } catch (error) {
        throw worded(error);
      }
    },
  };
}
