import React, { useCallback } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import AccountDetail from "../accounts/AccountDetail.jsx";
import { accountItemTitle } from "../accounts/accounts-items.js";
import ChatgptOfflineNote from "./ChatgptOfflineNote.jsx";
import useAssistants from "./useAssistants.js";
import useChatgptLogin from "./useChatgptLogin.js";

/** "+ ChatGPT": the device-code login for agents (code, open link, cancel, resume). */
export default function ChatgptLoginDetail({ entry, data, navigate }) {
  const { runtime, refresh } = useAssistants();
  const ready = runtime.availability === "ready";
  const { reloadChatgpt } = data;
  const reload = useCallback(async () => {
    await reloadChatgpt();
    await refresh();
  }, [reloadChatgpt, refresh]);
  const login = useChatgptLogin({ reload });
  const { attempt } = login;
  return (
    <AccountDetail title={accountItemTitle(entry)}>
      <p className="accounts-note">{copy.accountsDescription}</p>
      <ErrorMessage error={login.error} />
      {!ready && <ChatgptOfflineNote navigate={navigate} />}
      {attempt && (
        <div className="accounts-confirmation" role="status">
          <p>{copy.loginStatus[attempt.status] || copy.loginStatus.failed}</p>
          {attempt.status === "failed" && attempt.diagnostic && (
            <p>
              {copy.loginFailure[attempt.diagnostic] || copy.loginFailure.LOGIN_FAILED}
            </p>
          )}
          {login.active && attempt.code && (
            <>
              <code className="accounts-device-code">{attempt.code}</code>
              <p>{copy.loginInstructions}</p>
              <p className="accounts-login-url">
                {copy.loginPage}{" "}
                <a href={attempt.url} target="_blank" rel="noopener noreferrer">
                  {attempt.url}
                </a>
              </p>
              <a
                className="button secondary"
                href={attempt.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {copy.loginOpen}
              </a>
            </>
          )}
          {login.active && (
            <button
              type="button"
              className="button secondary"
              disabled={login.busy}
              onClick={login.cancel}
            >
              {copy.loginCancel}
            </button>
          )}
        </div>
      )}
      {!login.active && (
        <button
          type="button"
          className="button primary"
          disabled={!ready || login.busy}
          onClick={login.start}
        >
          {login.busy ? copy.loading : copy.accountConnect}
        </button>
      )}
    </AccountDetail>
  );
}
