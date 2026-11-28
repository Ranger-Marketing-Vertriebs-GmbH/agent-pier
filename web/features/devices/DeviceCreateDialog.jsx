import React, { useId } from "react";
import AsyncForm from "../../components/AsyncForm.jsx";
import Modal from "../../components/Modal.jsx";
import { devicesCopy as copy } from "../../lib/i18n/messages/devices.js";

/**
 * "New device": one name. `create(name)` rejects with the refusal in words (a name
 * that is taken, the limit, too little disk space), shown in the form; the typed name
 * stays. The form's own lock keeps a second submit from sending a second request.
 */
export default function DeviceCreateDialog({ create, close }) {
  const hint = useId();
  return (
    <Modal title={copy.createDialog.title} close={close}>
      <AsyncForm
        button={copy.createDialog.submit}
        close={close}
        submit={async (data) => {
          await create(String(data.get("name") || "").trim());
          close();
        }}
      >
        <label>
          {copy.createDialog.name}
          <input
            name="name"
            required
            maxLength={40}
            placeholder={copy.createDialog.placeholder}
            autoComplete="off"
            aria-describedby={hint}
            data-autofocus
          />
        </label>
        <p id={hint} className="field-description">
          {copy.createDialog.nameHint}
        </p>
      </AsyncForm>
    </Modal>
  );
}
