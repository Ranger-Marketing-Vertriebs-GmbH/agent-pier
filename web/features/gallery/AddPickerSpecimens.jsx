import React, { useCallback, useState } from "react";
import AddPicker from "../../components/AddPicker.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { filterCandidates } from "../../components/add-picker.js";
import { galleryCopy as copy } from "../../lib/i18n/messages/gallery.js";
import { Specimen } from "./GallerySection.jsx";
import { mcpServers, sshHosts } from "./gallery-fixtures.js";

// AddPicker on 600 synthetic SSH accesses with a mode, and on a simulated server search.
export default function AddPickerSpecimens() {
  const p = copy.addPicker;
  const modes = [
    { value: "approval", label: p.approval },
    { value: "trusted", label: p.trusted },
    { value: "routines", label: p.routines },
  ];
  const [hosts] = useState(sshHosts);
  const [granted, setGranted] = useState([{ id: "prod-web-01", mode: "approval" }]);
  const [servers, setServers] = useState(["github"]);
  const search = useCallback(
    (query, { signal }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(filterCandidates(mcpServers(), query)),
          150,
        );
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      }),
    [],
  );
  const modeLabel = (value) => modes.find((mode) => mode.value === value)?.label;
  return (
    <>
      <Specimen label="AddPicker · modes · 600 items" wide>
        <ListCard label={p.sshCard}>
          {granted.map((grant) => (
            <ListRow key={grant.id} label={grant.id} value={modeLabel(grant.mode)} />
          ))}
          <AddPicker
            typeLabel={p.sshType}
            candidates={hosts}
            granted={granted.map((grant) => grant.id)}
            modes={modes}
            onAdd={(items, mode) =>
              setGranted((current) => [
                ...current,
                ...items.map((item) => ({ id: item.id, mode })),
              ])
            }
          />
        </ListCard>
      </Specimen>
      <Specimen label="AddPicker · search" wide>
        <ListCard label={p.mcpCard}>
          {servers.map((name) => (
            <ListRow key={name} label={name} />
          ))}
          <AddPicker
            typeLabel={p.mcpType}
            search={search}
            granted={servers}
            onAdd={(items) =>
              setServers((current) => [...current, ...items.map((item) => item.id)])
            }
          />
        </ListCard>
      </Specimen>
    </>
  );
}
