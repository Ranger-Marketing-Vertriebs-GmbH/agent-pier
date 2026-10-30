import { useEffect, useState } from "react";
import api from "../../lib/api.js";
import { notificationBase, reconcilePush } from "./push-reconcile.js";

// The person whose app is open ("owner" or `user:<id>`): enabling notifications in
// this browser remembers them, so only they get the device back on the next load.
let activePerson = null;
export const pushPerson = () => activePerson;

/** Registers this browser's push device again where needed, once per page load. */
export function usePushReconcile(person) {
  useEffect(() => {
    if (!person) return;
    activePerson = person;
    reconcilePush(person);
  }, [person]);
}

/**
 * Whether the person's notices still reach a device (server `health`), read after
 * this browser's own device was reconciled; null while unknown or on failure.
 */
export function usePushHealth(person) {
  const [health, setHealth] = useState(null);
  useEffect(() => {
    if (!person) return undefined;
    let disposed = false;
    reconcilePush(person)
      .then(() => api(notificationBase(person)))
      .then((status) => {
        if (!disposed && status?.enabled) setHealth(status.health || null);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [person]);
  return health;
}
