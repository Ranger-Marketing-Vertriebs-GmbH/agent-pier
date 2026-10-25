import React, { useEffect, useId, useState } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow, { ToggleRow, unknownValue } from "../../../components/ListRow.jsx";
import Segmented from "../../../components/Segmented.jsx";
import ReferenceRow from "../../../components/ReferenceRow.jsx";
import {
  InfoHintButton,
  InfoHintText,
  useInfoHint,
} from "../../../components/InfoHint.jsx";
import { routePath } from "../../../app/routes.js";
import { useCrossLink } from "../../../app/cross-link.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantShellCopy as shellCopy } from "../../../lib/i18n/messages/assistant-shell.js";
import { assistantPdfCopy as pdfCopy } from "../../../lib/i18n/messages/assistant-pdf.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import { assistantDreamingCopy as dreamingCopy } from "../../../lib/i18n/messages/assistant-dreaming.js";
import { assistantApi } from "../assistant-api.js";
import useDreaming from "../useDreaming.js";
import { shellEligible, shellLevels } from "../shell-level.js";
import { agentRoute, isPersonal, webCapabilityKeys } from "./agent-settings-fields.js";
import useCount from "./useCount.js";

const names = {
  webSearch: ["enableWebSearch", "webSearchDescription"],
  webFetch: ["enableWebFetch", "webFetchDescription"],
  browser: ["enableBrowser", "browserDescription"],
  documents: ["enableDocuments", "documentsDescription"],
  readPdfs: [() => pdfCopy.enable, () => pdfCopy.description],
  createImages: ["enableCreateImages", "createImagesDescription"],
};

/**
 * Memory and reminders switches; the saved-notes row opens the memory editor. It shows
 * no count: MEMORY.md and USER.md are not files of the `memory/` listing. While
 * dreaming is on, a permanent agent (and a new one) keeps its memory on.
 */
// `notes` false hides the notes link (a user's own agent before her opt-in).
export function MemoryGroup({ assistant, draft, go, notes = true }) {
  const id = useId();
  const copy = assistantCopy.personal;
  const saved = Boolean(assistant) && assistant.capabilities?.memory === true;
  const { dreaming } = useDreaming();
  const permanent = !assistant || (isPersonal(assistant) && !assistant.archivedAt);
  const locked = dreaming?.enabled === true && permanent && draft.values.memory === true;
  return (
    <section aria-labelledby={id}>
      <GroupLabel id={id} hint={`${copy.capabilityHint} ${copy.memoryHint}`}>
        {copy.memoryGroup}
      </GroupLabel>
      <ListCard labelledBy={id}>
        <ToggleRow
          label={copy.enableMemory}
          sub={locked ? dreamingCopy.memoryLocked : copy.memoryDescription}
          checked={draft.values.memory}
          disabled={locked}
          onChange={(on) => draft.set("memory", on)}
        />
        {saved && notes && (
          <ListRow
            label={copy.notes}
            href={routePath(agentRoute(assistant.id, "capabilities", "memory"))}
            onClick={() => go("capabilities", "memory")}
          />
        )}
        <ToggleRow
          label={copy.enableReminders}
          sub={copy.remindersDescription}
          checked={draft.values.reminders}
          onChange={(on) => draft.set("reminders", on)}
        />
      </ListCard>
    </section>
  );
}

/** Web switches with today's availability rules and the search provider reference. */
// `images` is false while no ChatGPT account can create images.
export function WebGroup({ draft, browser, images, creating = false, navigate }) {
  const id = useId();
  const crossLink = useCrossLink();
  const copy = assistantCopy.personal;
  const [search, setSearch] = useState(null);
  const [pdf, setPdf] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    // Unknown stays usable: the server decides when the agent starts.
    assistantApi
      .webSearch(controller.signal)
      .then(setSearch)
      .catch(() => {});
    assistantApi
      .pdfModel(controller.signal)
      .then(setPdf)
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const missing = {
    browser: browser?.available === false ? copy.browserUnavailable : "",
    webSearch: search && search.ready === false ? copy.searchUnavailable : "",
    createImages: images === false ? copy.imagesUnavailable : "",
  };
  const provider = search?.provider
    ? (settingsCopy.searchProviders[search.provider] ?? search.provider)
    : unknownValue;
  const accounts = crossLink({
    view: "accounts",
    section: "services",
    item: "web-search",
  });
  const pdfAccounts = crossLink({
    view: "accounts",
    section: "services",
    item: "pdf-model",
  });
  return (
    <section aria-labelledby={id}>
      <GroupLabel id={id} hint={copy.webHint}>
        {copy.webGroup}
      </GroupLabel>
      <ListCard labelledBy={id}>
        {webCapabilityKeys.map((key) => {
          const [label, description] = names[key].map((name) =>
            typeof name === "function" ? name() : copy[name],
          );
          // A new agent has no stored profile yet: web tools are switched on after saving.
          const reason = creating ? copy.availableAfterSaving : missing[key];
          const on = !creating && draft.values[key] === true;
          return (
            <ToggleRow
              key={key}
              label={label}
              sub={reason || description}
              checked={on}
              // A switched-on capability can always be turned off.
              disabled={creating || (Boolean(reason) && !on)}
              onChange={(next) => draft.set(key, next)}
            />
          );
        })}
      </ListCard>
      {!creating && (
        <ReferenceRow
          title={settingsCopy.searchProvider(provider)}
          href={routePath(accounts)}
          onOpen={() => navigate(accounts)}
        />
      )}
      {!creating && (
        <ReferenceRow
          title={pdfCopy.reference(pdf?.modelId ?? (pdf ? pdfCopy.notSet : unknownValue))}
          href={routePath(pdfAccounts)}
          onOpen={() => navigate(pdfAccounts)}
        />
      )}
    </section>
  );
}

/** Shell level: selected hint and warning visible, the other levels' hints behind ⓘ. */
export function ShellGroup({ assistant, draft, go, creating = false }) {
  const id = useId();
  const others = useInfoHint();
  const eligible = shellEligible(assistant);
  const reason = eligible
    ? ""
    : assistant?.archivedAt
      ? shellCopy.archived
      : shellCopy.temporary;
  const level = draft.values.shell;
  const otherHints = shellLevels
    .filter((value) => value !== level)
    .map((value) => `${shellCopy.levels[value]}: ${shellCopy.levelHints[value]}`)
    .join(" ");
  const listed = Boolean(assistant) && eligible && !creating;
  const entries = useCount(
    () =>
      assistantApi
        .shellAllowlist(assistant.id)
        .then((result) => (result.entries || []).length),
    listed,
    assistant?.id,
  );
  return (
    <section id="agent-shell" aria-labelledby={id}>
      <GroupLabel id={id} hint={shellCopy.intro}>
        {shellCopy.title}
      </GroupLabel>
      <div className="list-card">
        <div className="list-row agent-shell-levels">
          <Segmented
            label={shellCopy.title}
            options={shellLevels.map((value) => ({
              value,
              label: shellCopy.levels[value],
            }))}
            value={level}
            disabled={!eligible || draft.saving}
            onChange={(next) => draft.set("shell", next)}
          />
        </div>
        {reason ? (
          <p className="agent-row-note">{reason}</p>
        ) : (
          <div className="agent-row-note">
            <p>
              {shellCopy.levelHints[level]} <InfoHintButton hint={others} />
            </p>
            <InfoHintText hint={others}>{otherHints}</InfoHintText>
          </div>
        )}
        {listed && (
          <ListRow
            label={shellCopy.allowlist}
            value={entries ?? unknownValue}
            href={routePath(agentRoute(assistant.id, "capabilities", "allowlist"))}
            onClick={() => go("capabilities", "allowlist")}
          />
        )}
      </div>
      {eligible &&
        (level === "off" ? (
          <p className="assistant-note">{shellCopy.offHint}</p>
        ) : (
          <p className="assistant-shell-warning">{shellCopy.warning}</p>
        ))}
      {eligible && assistant?.shellPending && (
        <p role="status" className="assistant-notice">
          {shellCopy.pending}
        </p>
      )}
    </section>
  );
}
