import React, { useState } from "react";
import Sheet from "../../../components/Sheet.jsx";
import Modal from "../../../components/Modal.jsx";
import AsyncForm from "../../../components/AsyncForm.jsx";
import ConfirmDialog from "../../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import { agentChatsCopy as copy } from "../../../lib/i18n/messages/agent-chats.js";
import { chatTitle } from "./chat-names.js";

/**
 * What can be done with one chat: Rename (a sheet with its title), Archive or
 * Restore, and Delete behind a confirmation. The main chat stays: it is renamed
 * only, since reminders, routines and Telegram deliver into it. `onDone(chat)` follows
 * an archive, restore or delete; a rename returns through `onClose`.
 */
export default function ChatActionsSheet({ chat, chats, onClose, onDone = onClose }) {
  const [step, setStep] = useState("actions");
  const [error, setError] = useState("");
  if (!chat) return null;
  const title = chatTitle(chat);
  const run = async (action) => {
    setError("");
    try {
      await action();
      onDone(chat);
    } catch (e) {
      setError(e.message);
    }
  };
  if (step === "rename")
    return (
      <Modal title={copy.renameTitle} close={onClose}>
        <AsyncForm
          button={copy.save}
          close={onClose}
          submit={async (data) => {
            await chats.rename(chat, String(data.get("title") || "").trim());
            onClose();
          }}
        >
          <label>
            {copy.titleLabel}
            <input
              name="title"
              defaultValue={chat.title || ""}
              maxLength={80}
              required
              autoComplete="off"
            />
          </label>
        </AsyncForm>
      </Modal>
    );
  if (step === "delete")
    return (
      <ConfirmDialog
        title={copy.deleteTitle(title)}
        body={copy.deleteBody}
        confirmLabel={copy.deleteConfirm}
        destructive
        onCancel={onClose}
        onConfirm={async () => {
          await chats.remove(chat);
          onDone(chat);
        }}
      />
    );
  return (
    <Sheet open title={copy.actionsFor(title)} onCancel={onClose}>
      <ErrorMessage error={error} />
      <div className="sheet-actions">
        <button
          type="button"
          className="button secondary"
          onClick={() => setStep("rename")}
        >
          {copy.rename}
        </button>
        {!chat.main &&
          (chat.archivedAt ? (
            <button
              type="button"
              className="button secondary"
              onClick={() => run(() => chats.restore(chat))}
            >
              {copy.restore}
            </button>
          ) : (
            <button
              type="button"
              className="button secondary"
              onClick={() => run(() => chats.archive(chat))}
            >
              {copy.archive}
            </button>
          ))}
        {!chat.main && (
          <button
            type="button"
            className="button destructive"
            onClick={() => setStep("delete")}
          >
            {copy.delete}
          </button>
        )}
        <button type="button" className="button text" onClick={onClose}>
          {copy.close}
        </button>
      </div>
    </Sheet>
  );
}
