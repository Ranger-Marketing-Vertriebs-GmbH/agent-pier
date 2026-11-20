import { startupStage } from "../../startup/status.js";
import useLanguage from "../../lib/i18n/useLanguage.js";
import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { startVisiblePolling } from "../../lib/visible-polling.js";
import { LoginContext } from "./LoginContext.js";
import { loginRequest, announceLoginChange } from "./login-api.js";
import { endPushSubscription, knownDevice } from "../notifications/device-identity.js";
import { rememberPushDevice } from "../notifications/push-reconcile.js";
import LoginPage from "./LoginPage.jsx";
import { loginCopy as copy } from "../../lib/i18n/messages/login.js";
import { clearChatCache } from "../chat/chat-session-cache.js";
import { sharedDrafts } from "../assistants/useAssistants.js";
import { clearAgentList } from "../assistants/agent-list-cache.js";
import { liveAuthCheckEvent } from "../../lib/live/live-client.js";
import { openPreviewReturn, previewParams, previewReturn } from "./preview-return.js";
import api from "../../lib/api.js";
import { forgetSignedIn, rememberSignedIn, wasSignedIn } from "./signed-in-cache.js";
import { clearWorkspaceState } from "../../app/workspace-state-cache.js";
// Everything this page remembers for the signed-in user. Agent data, the agent chat
// cache and its offline outbox live in the app and go with its unmount; the agent
// list kept on the device for offline use goes here.
const forgetUser = () => {
  sharedDrafts.clearAll();
  clearAgentList();
  clearWorkspaceState();
  forgetSignedIn();
  void clearChatCache();
};
import "./login.css";
// A status read that failed is tried again after 2 s, 4 s, 8 s … up to one minute.
const FIRST_RETRY_MS = 2000;
const LONGEST_RETRY_MS = 60000;
// The status shown while AgentPier cannot be reached on a device last signed in as
// the owner: the app opens with what the device kept (agent list, workspace state,
// chats) and its own offline notices, and the next answer replaces it.
const OFFLINE_STATUS = { configured: true, authenticated: true, offline: true };
// A restricted user never loads the owner's app, only her own shell.
const UserApp = lazy(() => import("../users/UserApp.jsx"));
export default function LoginGate({ children }) {
  useLanguage();
  const generation = useRef(0);
  const invalidate = useCallback(() => ++generation.current, []);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  // A preview sent the owner here to sign in; read its return target once.
  const [previewTarget] = useState(() => previewReturn(location.search, location));
  useEffect(() => {
    const url = new URL(location.href);
    if (!url.searchParams.has("preview")) return;
    for (const name of previewParams) url.searchParams.delete(name);
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  }, []);
  const returned = useRef(false);
  useEffect(() => {
    if (returned.current || !previewTarget) return;
    if (!status?.authenticated || status.role === "user") return;
    returned.current = true;
    // Only a preview that is open right now is a place to return to.
    void openPreviewReturn(previewTarget, () => api("/previews")).then((target) => {
      if (target) location.replace(target);
    });
  }, [previewTarget, status]);
  useEffect(() => {
    startupStage(status || error ? "done" : "authenticating");
  }, [status, error]);
  const retry = useRef({ timer: null, delay: FIRST_RETRY_MS });
  const stopRetry = useCallback(() => {
    clearTimeout(retry.current.timer);
    retry.current = { timer: null, delay: FIRST_RETRY_MS };
  }, []);
  const refresh = useCallback(async () => {
    const current = invalidate();
    clearTimeout(retry.current.timer);
    try {
      const next = await loginRequest("status");
      if (typeof next.configured !== "boolean" || typeof next.authenticated !== "boolean")
        throw new Error(copy.failed);
      if (current !== generation.current) return;
      if (!next.authenticated) forgetUser();
      rememberSignedIn(next);
      stopRetry();
      setStatus(next);
      setError("");
    } catch (failure) {
      if (current !== generation.current) return;
      // Unreachable on a device last signed in as the owner: the app in offline mode.
      if (failure.code === "UNREACHABLE" && wasSignedIn()) {
        setStatus((shown) => (shown?.authenticated ? shown : OFFLINE_STATUS));
        setError("");
      } else setError(failure.message);
      const { delay } = retry.current;
      retry.current = {
        delay: Math.min(delay * 2, LONGEST_RETRY_MS),
        timer: setTimeout(() => refreshRef.current(), delay),
      };
    }
  }, [invalidate, stopRetry]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => stopRetry, [stopRetry]);
  useEffect(() => {
    const expired = () => {
      invalidate();
      forgetUser();
      setStatus({ configured: true, authenticated: false });
    };
    const changed = (event) => {
      if (event.key !== "agentpier-auth-change") return;
      forgetUser();
      refresh();
    };
    // The live channel refused the socket (1008): one login read, never a second
    // while it runs. Logged out shows the login; logged in leaves the reconnect to
    // the live client's own backoff. A hidden tab reads nothing: the visible-only poll
    // reads at once when it is shown again.
    let checking = null;
    const authCheck = () => {
      if (checking || document.hidden) return;
      checking = refresh().finally(() => {
        checking = null;
      });
    };
    window.addEventListener("agentpier-login-required", expired);
    window.addEventListener("storage", changed);
    window.addEventListener("focus", refresh);
    window.addEventListener(liveAuthCheckEvent, authCheck);
    // Visible: the explicit refresh is the first read and the poll's first run is
    // skipped. Hidden: nothing is requested until the poll's first visible run.
    let skip = !document.hidden;
    if (skip) refresh();
    const stop = startVisiblePolling(async () => {
      if (skip) skip = false;
      else await refresh();
    }, 300000);
    return () => {
      invalidate();
      stop();
      window.removeEventListener("agentpier-login-required", expired);
      window.removeEventListener("storage", changed);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(liveAuthCheckEvent, authCheck);
    };
  }, [refresh, invalidate]);
  async function logout() {
    await loginRequest("logout", { deviceId: knownDevice() });
    await endPushSubscription();
    await rememberPushDevice(null);
    invalidate();
    forgetUser();
    setStatus({ configured: true, authenticated: false });
    announceLoginChange();
  }
  if (status?.authenticated && status.role === "user")
    return (
      <LoginContext value={{ logout }}>
        <Suspense>
          <UserApp status={status} />
        </Suspense>
      </LoginContext>
    );
  if (status?.authenticated)
    return <LoginContext value={{ logout }}>{children}</LoginContext>;
  if (status) return <LoginPage status={status} onLogin={refresh} refresh={refresh} />;
  return (
    <main className="login-page">
      <div className="login-card">
        <p role={error ? "alert" : "status"}>{error || copy.loading}</p>
        {error && (
          <button className="button secondary" onClick={refresh}>
            {copy.retry}
          </button>
        )}
      </div>
    </main>
  );
}
