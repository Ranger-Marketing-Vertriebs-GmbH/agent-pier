import React, { useEffect, useId, useState } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { RadioRow, ToggleRow } from "../../../components/ListRow.jsx";
import { agentWizardCopy } from "../../../lib/i18n/messages/agent-wizard.js";
import { assistantPdfCopy as pdfCopy } from "../../../lib/i18n/messages/assistant-pdf.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { connectionsRoute } from "../../connections/routes.js";
import { assistantApi } from "../assistant-api.js";
import { ShellGroup } from "../settings/CapabilityGroups.jsx";
import LockedNotice from "../settings/LockedNotice.jsx";
import SetupSheet from "./SetupSheet.jsx";
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
 * einrichten" in a side sheet; it never blocks creating. Shell uses the settings'
 * control (confirmations as today); agents of users keep it locked.
 */
export default function StepCapabilities({ d, set, runtime, models }) {
  const id = useId();
  const [search, setSearch] = useState(null);
  const [setup, setSetup] = useState(false);
  const loadSearch = () =>
    assistantApi
      .webSearch()
      .then(setSearch)
      .catch(() => {});
  useEffect(() => {
    loadSearch();
  }, []);
  const images = models.some(
    (m) => m.providerId === "openai-chatgpt" && (m.signedIn ?? m.available) === true,
  );
  const reasons = {
    webSearch: search && search.ready === false ? personal().searchUnavailable : "",
    browser: runtime?.browser?.available === false ? personal().browserUnavailable : "",
    createImages: images ? "" : personal().imagesUnavailable,
  };
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
          {group === "webGroup" && reasons.webSearch && (
            <button
              type="button"
              className="group-label-action agent-wizard-setup"
              onClick={() => setSetup(true)}
            >
              {personal().enableWebSearch}: {copy().setUpHere}
            </button>
          )}
        </section>
      ))}
      {d.owner ? (
        <LockedNotice items={["shell", "sessions"]} />
      ) : (
        <ShellGroup draft={draft} creating />
      )}
      <p className="field-description">{copy().later}</p>
      {setup && (
        <SetupSheet
          title={assistantCopy.webSearch.title}
          text={personal().searchUnavailable}
          route={connectionsRoute("services", "web-search")}
          onRefresh={loadSearch}
          onClose={() => setSetup(false)}
        />
      )}
    </>
  );
}
