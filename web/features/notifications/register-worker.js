export async function getWorkerRegistration({ create = false } = {}) {
  if (!globalThis.isSecureContext || !("serviceWorker" in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (existing || !create) return existing;
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  if (registration.active) return registration;
  return navigator.serviceWorker.ready;
}
export function registerPublicWorker() {
  if (import.meta.env.PROD) getWorkerRegistration({ create: true }).catch(() => {});
}
