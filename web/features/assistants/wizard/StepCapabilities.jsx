import React, { useEffect, useId, useState } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { RadioRow, ToggleRow } from "../../../components/ListRow.jsx";
import { agentWizardCopy } from "../../../lib/i18n/messages/agent-wizard.js";
import { assistantPdfCopy as pdfCopy } from "../../../lib/i18n/messages/assistant-pdf.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantApi } from "../assistant-api.js";
import { ShellGroup } from "../settings/CapabilityGroups.jsx";
import LockedNotice from "../settings/LockedNotice.jsx";
import ConnectModelSheet from "./ConnectModelSheet.jsx";
import ServiceSheet from "./ServiceSheet.jsx";
import {
  matchingProfile,
  profileIds,
  profileRisk,
  profileSwitches,
} from "./wizard-profiles.js";

const copy = () => agentWizardCopy.capabilities;
const personal = () => assistantCopy.personal;
const groups = [
  ["memoryGroup", ["memory", "reminders"]],
  [
    "webGroup",
    ["webSearch", "webFetch", "documents", "readPdfs", "browser", "createImages"],
  ],
];
const texts = {
  memory: () => [personal().enableMemory, personal().memoryDescription],
  reminders: () => [personal().enableReminders, personal().remindersDescription],
  webSearch: () => [personal().enableWebSearch, personal().webSearchDescription],
  webFetch: () => [personal().enableWebFetch, personal().webFetchDescription],
  documents: () => [personal().enableDocuments, personal().documentsDescription],
  readPdfs: () => [pdfCopy.enable, pdfCopy.description],
  browser: () => [personal().enableBrowser, personal().browserDescription],
  createImages: () => [personal().enableCreateImages, personal().createImagesDescription],
};

/**
 * Schritt 3 (handoff 5.3): a profile sets the switches below it (wizard-profiles.js),
 * which stay editable. An unavailable service names its reason and offers "hier
 * einrichten": its Zugänge form in a side sheet (web search, the optional PDF model;
 * images need ChatGPT, so "+ Modell verbinden"); it never blocks creating. Shell uses
 * the settings' control (confirmations as today); agents of users keep it locked.
 */
export default function StepCapabilities({ d, set, runtime, models }) {
  const id = useId();
  const [search, setSearch] = useState(null);
  const [pdf, setPdf] = useState(null);
  const [sheet, setSheet] = useState("");
  // Unknown stays usable: the server decides when the agent starts.
  const loadServices = () => {
    assistantApi
      .webSearch()
      .then(setSearch)
      .catch(() => {});
    assistantApi
      .pdfModel()
      .then(setPdf)
      .catch(() => {});
  };
  useEffect(() => {
    loadServices();
  }, []);
  const images = models.some(
    (m) => m.providerId === "openai-chatgpt" && (m.signedIn ?? m.available) === true,
  );
  const reasons = {
    webSearch: search && search.ready === false ? personal().searchUnavailable : "",
    browser: runtime?.browser?.available === false ? personal().browserUnavailable : "",
    createImages: images ? "" : personal().imagesUnavailable,
  };
  // "hier einrichten" rows: [sheet, shown, label]. The PDF model is optional (a
  // fallback for models without images), so it is offered while none is chosen.
  const setUps = [
    ["web-search", Boolean(reasons.webSearch), personal().enableWebSearch],
    [
      "pdf-model",
      d.readPdfs === true && Boolean(pdf) && !pdf.modelId,
      pdfCopy.reference(pdfCopy.notSet),
    ],
    ["images", Boolean(reasons.createImages), personal().enableCreateImages],
  ];
  const current = matchingProfile(d);
  const pick = (profile) =>
    set({
      profile,
      ...profileSwitches(profile),
      ...(d.owner ? { shell: "off" } : {}),
    });
  const draft = {
    values: d,
    set: (key, value) => set({ [key]: value, profile: "" }),
    saving: false,
  };
  return (
    <>
      <section aria-labelledby={id}>
        <GroupLabel id={id}>
          {copy().profile}
          <span className="agents-hub-count">{copy().profileSub}</span>
        </GroupLabel>
        <ListCard labelledBy={id}>
          {profileIds.map((profile) => (
            <RadioRow
              key={profile}
              name={`${id}-profile`}
              value={profile}
              checked={current === profile}
              label={`${copy().profiles[profile].name} · ${copy().risk[profileRisk[profile]]}`}
              sub={copy().profiles[profile].description}
              onChange={pick}
            />
          ))}
        </ListCard>
        {!current && <p className="field-description">{copy().custom}</p>}
      </section>
      {groups.map(([group, keys]) => (
        <section key={group} aria-labelledby={`${id}-${group}`}>
          <GroupLabel id={`${id}-${group}`}>{personal()[group]}</GroupLabel>
          <ListCard labelledBy={`${id}-${group}`}>
            {keys.map((key) => {
              const [label, description] = texts[key]();
              const reason = reasons[key] || "";
              return (
                <ToggleRow
                  key={key}
                  label={label}
                  sub={reason || description}
                  checked={d[key] === true}
                  onChange={(on) => draft.set(key, on)}
                />
              );
            })}
          </ListCard>
          {group === "webGroup" &&
            setUps
              .filter(([, shown]) => shown)
              .map(([key, , label]) => (
                <button
                  key={key}
                  type="button"
                  className="group-label-action agent-wizard-setup"
                  onClick={() => setSheet(key)}
                >
                  {label}: {copy().setUpHere}
                </button>
              ))}
        </section>
      ))}
      {d.owner ? (
        <LockedNotice items={["shell", "sessions"]} />
      ) : (
        <ShellGroup draft={draft} creating />
      )}
      <p className="field-description">{copy().later}</p>
      {(sheet === "web-search" || sheet === "pdf-model") && (
        <ServiceSheet
          kind={sheet}
          title={sheet === "web-search" ? assistantCopy.webSearch.title : pdfCopy.title}
          onClose={() => {
            setSheet("");
            loadServices();
          }}
        />
      )}
      {sheet === "images" && <ConnectModelSheet onClose={() => setSheet("")} />}
    </>
  );
}
