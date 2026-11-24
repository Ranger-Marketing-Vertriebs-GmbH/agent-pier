import React, { useRef, useState } from "react";
import { usePageAction } from "../../app/page-action.js";
import AsyncForm from "../../components/AsyncForm.jsx";
import Checkbox from "../../components/Checkbox.jsx";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import Modal from "../../components/Modal.jsx";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { autopilotActionsCopy as copy } from "../../lib/i18n/messages/autopilot-actions.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import OrderPermissions from "./OrderPermissions.jsx";
import OrderSessionFields, { useOrderSession } from "./OrderSessionFields.jsx";
import { orderActions } from "./order-actions.js";
import "./order-actions.css";

function PolicyDialog({ order, save, close }) {
  // Only send fields the owner changed. A live update to the other decision
  // should remain visible and must survive this save.
  const [changes, setChanges] = useState({});
  const policy = { ...order, ...changes };
  const patch = Object.fromEntries(
    Object.entries(changes).filter(([key, value]) => order[key] !== value),
  );
  return (
    <Modal title={copy.editPolicy} close={close}>
      <AsyncForm
        close={close}
        button={commonCopy.save}
        disabled={!Object.keys(patch).length}
        submit={() => save(patch)}
      >
        <OrderPermissions
          policy={policy}
          change={(key, value) => setChanges({ ...changes, [key]: value })}
        />
      </AsyncForm>
    </Modal>
  );
}

function RecoveryDialog({ order, state, confirm, close }) {
  const [changeAccess, setChangeAccess] = useState(false);
  const session = useOrderSession(state, order.selection);
  // A currently mapped session owns its account. Only a missing session can
  // accept a corrected selection and otherwise keeps its registered selection.
  const replaceAccess = !order.session && changeAccess;
  return (
    <ConfirmDialog
      title={copy.recover}
      body={copy.recoveryHint}
      confirmLabel={copy.recover}
      onCancel={close}
      onConfirm={() =>
        confirm({ recover: true, ...(replaceAccess ? { session: session.body } : {}) })
      }
      confirmDisabled={replaceAccess && !session.access.ready}
    >
      {!order.session && (
        <Checkbox
          label={copy.changeAccess}
          checked={changeAccess}
          onChange={setChangeAccess}
        />
      )}
      {replaceAccess && <OrderSessionFields session={session} />}
    </ConfirmDialog>
  );
}

function RemoveDialog({ order, confirm, close }) {
  const [name, setName] = useState("");
  return (
    <ConfirmDialog
      destructive
      title={copy.removeTitle(order.title)}
      body={[copy.removeEffect, copy.stopFirst]}
      confirmLabel={order.cleanup ? copy.finishRemoval : copy.remove}
      confirmDisabled={name !== order.title}
      onCancel={close}
      onConfirm={confirm}
    >
      <label>
        {copy.typeTitle}
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
    </ConfirmDialog>
  );
}

export default function OrderControls({ order, state, onUpdated, onRemoved }) {
  const [dialog, setDialog] = useState(null);
  const lifecycle = useRef(null);
  const mutation = useAsyncAction();
  const actions = orderActions(order);
  const path = `/autopilot/orders/${encodeURIComponent(order.id)}`;
  const close = () => setDialog(null);
  const offers = !dialog && !mutation.busy;
  usePageAction("autopilot-policy", () => setDialog("policy"), offers && actions.policy);
  usePageAction(
    "autopilot-pause",
    () => lifecycle.current?.focus(),
    offers && actions.pause,
  );
  usePageAction(
    "autopilot-resume",
    () => lifecycle.current?.focus(),
    offers && actions.resume,
  );
  usePageAction(
    "autopilot-recover",
    () => setDialog("recover"),
    offers && actions.recover,
  );
  usePageAction("autopilot-remove", () => setDialog("remove"), offers && actions.remove);
  async function update(suffix, method, body) {
    const result = await api(path + suffix, method, body);
    await onUpdated(result);
    close();
  }
  return (
    <section className="autopilot-controls">
      <GroupLabel
        as="h3"
        action={
          actions.policy
            ? {
                label: copy.editPolicy,
                onClick: () => setDialog("policy"),
                disabled: mutation.busy,
              }
            : undefined
        }
      >
        {copy.permissions}
      </GroupLabel>
      <ListCard label={copy.permissions}>
        <ListRow
          label={copy.implementationAuthorized}
          value={order.implementationAuthorized ? copy.granted : copy.withheld}
        />
        <ListRow
          label={copy.allowMerge}
          value={order.allowMerge ? copy.granted : copy.withheld}
        />
      </ListCard>
      <div className="autopilot-order-buttons">
        {(actions.pause || actions.resume) && (
          <button
            ref={lifecycle}
            className="button secondary"
            type="button"
            disabled={mutation.busy}
            onClick={() =>
              mutation.run(() =>
                update(actions.resume ? "/resume" : "/pause", "POST", {}),
              )
            }
          >
            {actions.resume ? copy.resume : copy.pause}
          </button>
        )}
        {actions.recover && (
          <button
            type="button"
            className="button secondary"
            disabled={mutation.busy}
            onClick={() => setDialog("recover")}
          >
            {copy.recover}
          </button>
        )}
        {actions.remove && (
          <button
            type="button"
            className="button secondary"
            disabled={mutation.busy}
            onClick={() => setDialog("remove")}
          >
            {order.cleanup ? copy.finishRemoval : copy.remove}
          </button>
        )}
      </div>
      <ErrorMessage error={mutation.error} />
      {dialog === "policy" && actions.policy && (
        <PolicyDialog
          order={order}
          close={close}
          save={(body) => update("", "PATCH", body)}
        />
      )}
      {dialog === "recover" && actions.recover && (
        <RecoveryDialog
          order={order}
          state={state}
          close={close}
          confirm={(body) => update("/resume", "POST", body)}
        />
      )}
      {dialog === "remove" && actions.remove && (
        <RemoveDialog
          order={order}
          close={close}
          confirm={async () => {
            await api(path, "DELETE");
            close();
            await onRemoved(order.id);
          }}
        />
      )}
    </section>
  );
}
