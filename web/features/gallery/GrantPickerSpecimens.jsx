import React, { useState } from "react";
import GrantPicker from "../../components/GrantPicker.jsx";
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

// GrantPicker split (stacked on phones), stacked at every width, and disabled.
export default function GrantPickerSpecimens() {
  return (
    <>
      <Sample label="GrantPicker · split · 600 items" />
      <Sample label="GrantPicker · stacked" stacked heading={copy.grantPicker.card} />
      <Sample label="GrantPicker · disabled" disabled />
    </>
  );
}
