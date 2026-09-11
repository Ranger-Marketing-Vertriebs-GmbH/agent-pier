import { commonCopy } from "../lib/i18n/messages/common.js";
import { appDialogsCopy as copy } from "../lib/i18n/messages/app.js";
import React from "react";
import api from "../lib/api.js";
import { names } from "../lib/providers.js";
import Modal from "../components/Modal.jsx";
import AsyncForm from "../components/AsyncForm.jsx";
import LaunchDialog from "../features/sessions/LaunchDialog.jsx";
import AccountDialog from "../features/accounts/AccountDialog.jsx";
import ToolInstaller from "../features/tools/ToolInstaller.jsx";
import { toolInstallerCopy } from "../lib/i18n/messages/tools.js";
export default function AppDialogs({
  modal,
  state,
  close,
  created,
  refresh,
  launch,
  page,
  select,
}) {
  return (
    <>
      {" "}
      {modal?.type === "launch" && (
        <LaunchDialog
          state={state}
          tool={modal.tool}
          initialCwd={modal.cwd}
          initialProfile={modal.profile}
          close={close}
          created={created}
        />
      )}
      {["install", "update"].includes(modal?.type) && (
        <Modal
          title={
            modal.type === "update"
              ? toolInstallerCopy.updateTitle(names[modal.tool])
              : commonCopy.installTitle(names[modal.tool])
          }
          close={close}
        >
          <ToolInstaller
            key={modal.tool}
            tool={modal.tool}
            update={modal.type === "update"}
            request={api}
            refresh={refresh}
            close={close}
            launch={() => launch(modal.tool)}
            configure={() => page("repositories")}
          />
        </Modal>
      )}
      {modal?.type === "account" && (
        <AccountDialog
          account={modal.item}
          tools={state.tools}
          close={close}
          saved={refresh}
        />
      )}
      {modal &&
        ["rename", "stop", "remove", "deleteAccount", "login"].includes(modal.type) && (
          <Modal
            title={
              {
                rename: commonCopy.renameSession,
                stop: copy.titleStop,
                remove: copy.titleRemove,
                deleteAccount: copy.titleDeleteAccount,
                login: commonCopy.signInTitle(names[modal.item.tool]),
              }[modal.type]
            }
            close={close}
          >
            <AsyncForm
              close={close}
              danger={["stop", "remove", "deleteAccount"].includes(modal.type)}
              button={
                {
                  rename: commonCopy.save,
                  stop: commonCopy.stopNow,
                  remove: commonCopy.removeNow,
                  deleteAccount: commonCopy.deleteAccount,
                  login: copy.buttonLogin,
                }[modal.type]
              }
              submit={async (data) => {
                const item = modal.item;
                if (modal.type === "login") {
                  const session = await api(`/accounts/${item.id}/login`, "POST");
                  await created(session);
                  return;
                }
                if (modal.type === "rename")
                  await api(`/sessions/${item.id}`, "PATCH", {
                    name: data.get("name").trim(),
                  });
                if (modal.type === "stop") await api(`/sessions/${item.id}/stop`, "POST");
                if (modal.type === "remove") {
                  await api(`/sessions/${item.id}`, "DELETE");
                  select(null);
                }
                if (modal.type === "deleteAccount")
                  await api(`/accounts/${item.id}`, "DELETE");
                await refresh();
                close();
              }}
            >
              {modal.type === "rename" ? (
                <label>
                  {copy.renamedSessionLabel}
                  <input
                    name="name"
                    required
                    maxLength={100}
                    defaultValue={modal.item.name}
                    autoFocus
                  />
                </label>
              ) : (
                <p className="confirm-copy">
                  {
                    {
                      stop: copy.confirmCopyStop(modal.item.name),
                      remove: copy.confirmCopyRemove(modal.item.name),
                      deleteAccount: copy.confirmCopyDeleteAccount(
                        modal.item.name,
                        modal.item.tool === "claude" ? copy.keychainRetention : "",
                      ),
                      login: copy.confirmCopyLogin(modal.item.name),
                    }[modal.type]
                  }
                </p>
              )}
            </AsyncForm>
          </Modal>
        )}
    </>
  );
}
