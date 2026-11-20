import React, { useEffect, useState } from "react";
import GrantPicker, { grantDialogClass } from "../../components/GrantPicker.jsx";
import Modal from "../../components/Modal.jsx";
import { skeletonCopy } from "../../lib/i18n/messages/components.js";
import { galleryCopy as copy } from "../../lib/i18n/messages/gallery.js";
import { Specimen } from "./GallerySection.jsx";
import { sshHosts } from "./gallery-fixtures.js";

// 600 synthetic SSH accesses: prod-web-01 granted, prod-web-02 managed by the project.
function sampleEntries() {
  const managed = copy.grantPicker.managed;
  return sshHosts().map((entry) =>
    entry.id === "prod-web-02" ? { ...entry, locked: true, notes: [managed] } : entry,
  );
}

function Sample({ label, ...props }) {
  const p = copy.grantPicker;
  const [entries] = useState(sampleEntries);
  const [selected, setSelected] = useState(["prod-web-01"]);
  return (
    <Specimen label={label} wide>
      <GrantPicker
        entries={entries}
        selected={selected}
        onChange={setSelected}
        typeLabel={p.type}
        listLabel={p.list}
        {...props}
      />
    </Specimen>
  );
}

// A grant dialog that loads first and mounts the picker into the open dialog.
function SampleDialog({ close }) {
  const p = copy.grantPicker;
  const [entries, setEntries] = useState(null);
  const [selected, setSelected] = useState(["prod-web-01"]);
  useEffect(() => {
    const timer = setTimeout(() => setEntries(sampleEntries()), 150);
    return () => clearTimeout(timer);
  }, []);
  return (
    <Modal title={p.list} close={close} className={grantDialogClass} footer={null}>
      {entries ? (
        <GrantPicker
          entries={entries}
          selected={selected}
          onChange={setSelected}
          typeLabel={p.type}
          listLabel={p.list}
          autoFocus
        />
      ) : (
        <p className="dialog-hint">{skeletonCopy.loading}</p>
      )}
    </Modal>
  );
}

function DialogSample() {
  const [open, setOpen] = useState(false);
  return (
    <Specimen label="GrantPicker · dialog" wide>
      <div>
        <button type="button" className="button secondary" onClick={() => setOpen(true)}>
          {copy.sample.open(copy.grantPicker.list)}
        </button>
      </div>
      {open && <SampleDialog close={() => setOpen(false)} />}
    </Specimen>
  );
}

// GrantPicker split (stacked on phones), stacked at every width, disabled, and in a
// grant dialog that loads its entries.
export default function GrantPickerSpecimens() {
  return (
    <>
      <Sample label="GrantPicker · split · 600 items" />
      <Sample label="GrantPicker · stacked" stacked heading={copy.grantPicker.card} />
      <Sample label="GrantPicker · disabled" disabled />
      <DialogSample />
    </>
  );
}
