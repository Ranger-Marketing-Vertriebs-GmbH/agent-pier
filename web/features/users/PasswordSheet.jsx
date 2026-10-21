import React from "react";
import Modal from "../../components/Modal.jsx";
import AsyncForm from "../../components/AsyncForm.jsx";
import { userAppCopy as copy } from "../../lib/i18n/messages/user-app.js";
import { userApi } from "./user-api.js";

/**
 * Her new password: the current one and the new one (12 characters or more). This
 * session stays; her other devices are signed out (me-account.js).
 */
export default function PasswordSheet({ onDone, onCancel }) {
  return (
    <Modal title={copy.changePassword} close={onCancel}>
      <AsyncForm
        button={copy.changePassword}
        close={onCancel}
        submit={async (data) => {
          await userApi.changePassword({
            current: String(data.get("current") || ""),
            next: String(data.get("next") || ""),
          });
          onDone();
        }}
      >
        <label>
          {copy.currentPassword}
          <input
            name="current"
            type="password"
            autoComplete="current-password"
            required
            maxLength={1024}
          />
        </label>
        <label>
          {copy.newPassword}
          <input
            name="next"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={1024}
            aria-describedby="user-password-hint"
          />
        </label>
        <p id="user-password-hint" className="user-app-hint">
          {copy.passwordHint}
        </p>
      </AsyncForm>
    </Modal>
  );
}
