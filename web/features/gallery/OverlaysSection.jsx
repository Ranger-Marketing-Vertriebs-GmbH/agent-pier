import React, { useState } from "react";
import AsyncForm from "../../components/AsyncForm.jsx";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import ImageViewer from "../../components/ImageViewer.jsx";
import Modal from "../../components/Modal.jsx";
import Sheet from "../../components/Sheet.jsx";
import SidePanel from "../../components/SidePanel.jsx";
import UnsavedChangesSheet from "../../components/UnsavedChangesSheet.jsx";
import { useAlertDialogFocus } from "../../components/useAlertDialogFocus.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { galleryCopy as copy } from "../../lib/i18n/messages/gallery.js";
import { GallerySection, Specimen } from "./GallerySection.jsx";
import { sampleImage } from "./gallery-fixtures.js";

const s = () => copy.sample;

function InlineConfirm({ onCancel, onConfirm }) {
  const { ref, onKeyDown } = useAlertDialogFocus(onCancel);
  return (
    <div
      ref={ref}
      role="alertdialog"
      aria-label={s().inlineConfirm}
      className="gallery-inline-confirm"
      onKeyDown={onKeyDown}
    >
      <p>{s().confirmQuestion}</p>
      <div className="gallery-row">
        <button
          type="button"
          className="button secondary"
          data-autofocus
          onClick={onCancel}
        >
          {commonCopy.cancel}
        </button>
        <button type="button" className="button danger" onClick={onConfirm}>
          {commonCopy.remove}
        </button>
      </div>
    </div>
  );
}

// A permanent delete: the action stays off until the name is typed exactly.
function TypedConfirm({ close }) {
  const [name, setName] = useState("");
  return (
    <ConfirmDialog
      destructive
      title={s().confirmTypedTitle}
      body={s().confirmTypedBody}
      confirmLabel={s().deleteNow}
      confirmDisabled={name !== "Helper"}
      onCancel={close}
      onConfirm={close}
    >
      <label>
        {s().confirmTypedField}
        <input
          value={name}
          autoComplete="off"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
    </ConfirmDialog>
  );
}

function Overlay({ open, close }) {
  const body = <p>{s().dialogBody}</p>;
  if (open === "modal")
    return (
      <Modal title={s().modal} close={close}>
        <div className="form-content">{body}</div>
      </Modal>
    );
  if (open === "modalFooter")
    return (
      <Modal
        title={s().modalFooter}
        close={close}
        footer={
          <>
            <button type="button" className="button secondary" onClick={close}>
              {commonCopy.cancel}
            </button>
            <button type="button" className="button primary" onClick={close}>
              {commonCopy.save}
            </button>
          </>
        }
      >
        {body}
      </Modal>
    );
  if (open === "asyncForm")
    return (
      <Modal title={s().asyncForm} close={close}>
        <AsyncForm submit={close} button={commonCopy.save} close={close}>
          <label>
            {s().fieldName}
            <input name="name" autoComplete="off" />
          </label>
        </AsyncForm>
      </Modal>
    );
  if (open === "confirmDelete")
    return (
      <ConfirmDialog
        destructive
        title={s().confirmDeleteTitle}
        body={s().confirmDeleteBody}
        confirmLabel={s().deleteNow}
        onCancel={close}
        onConfirm={close}
      />
    );
  if (open === "confirmTyped") return <TypedConfirm close={close} />;
  if (open === "confirmOther")
    return (
      <ConfirmDialog
        title={s().confirmOtherTitle}
        body={s().confirmOtherBody}
        confirmLabel={s().activateNow}
        onCancel={close}
        onConfirm={close}
      />
    );
  if (open === "sidePanel")
    return (
      <SidePanel title={s().sidePanel} subtitle={s().sub} close={close}>
        {body}
      </SidePanel>
    );
  if (open === "imageViewer")
    return (
      <ImageViewer
        src={sampleImage}
        alt={s().imageAlt}
        title={s().imageAlt}
        close={close}
      />
    );
  return null;
}

export default function OverlaysSection() {
  const [open, setOpen] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const close = () => setOpen("");
  const opener = (id, label) => (
    <button type="button" className="button secondary" onClick={() => setOpen(id)}>
      {s().open(label)}
    </button>
  );
  return (
    <GallerySection id="overlays">
      <Specimen label="ConfirmDialog" wide>
        {opener("confirmDelete", s().confirmDelete)}
        {opener("confirmOther", s().confirmOther)}
        {opener("confirmTyped", s().confirmTyped)}
      </Specimen>
      <Specimen label="Modal · AsyncForm · SidePanel · ImageViewer" wide>
        {opener("modal", s().modal)}
        {opener("modalFooter", s().modalFooter)}
        {opener("asyncForm", s().asyncForm)}
        {opener("sidePanel", s().sidePanel)}
        {opener("imageViewer", s().imageViewer)}
      </Specimen>
      <Specimen label="Sheet · UnsavedChangesSheet" wide>
        {opener("sheet", s().sheet)}
        {opener("unsaved", s().unsaved)}
      </Specimen>
      <Specimen label="useAlertDialogFocus" wide>
        {confirming ? (
          <InlineConfirm
            onCancel={() => setConfirming(false)}
            onConfirm={() => {
              setConfirming(false);
              setConfirmed(true);
            }}
          />
        ) : (
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              setConfirmed(false);
              setConfirming(true);
            }}
          >
            {s().inlineConfirm}
          </button>
        )}
        {confirmed && <p role="status">{s().confirmed}</p>}
      </Specimen>
      <Overlay open={open} close={close} />
      <Sheet open={open === "sheet"} title={s().sheet} onCancel={close}>
        <p className="sheet-body">{s().dialogBody}</p>
        <div className="sheet-actions">
          <button type="button" className="button primary" onClick={close}>
            {commonCopy.confirm}
          </button>
          <button type="button" className="button text" onClick={close}>
            {commonCopy.cancel}
          </button>
        </div>
      </Sheet>
      <UnsavedChangesSheet
        open={open === "unsaved"}
        tab={s().tabName}
        count={2}
        onSave={close}
        onDiscard={close}
        onCancel={close}
      />
    </GallerySection>
  );
}
