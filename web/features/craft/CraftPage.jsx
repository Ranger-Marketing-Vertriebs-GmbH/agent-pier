import React, { useId, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { SelectRow, ToggleRow } from "../../components/ListRow.jsx";
import Segmented from "../../components/Segmented.jsx";
import SettingsShell from "../../components/SettingsShell.jsx";
import { isPlainClick } from "../../components/link-click.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { formatMessageTime } from "../../lib/i18n/index.js";
import { craftCopy as copy } from "../../lib/i18n/messages/craft.js";
import { routePath } from "../../app/routes.js";
import { codingRoute } from "../coding/routes.js";
import CraftStartForm, { accountOptions, modeOptions } from "./CraftStartForm.jsx";
import RebuildDetail from "./RebuildDetail.jsx";
import { byRecent, statusTone } from "./rebuild-presentation.js";
import { craftRoute } from "./routes.js";
import { useRebuilds } from "./useRebuilds.js";
import "./craft.css";

/**
 * The Craft Anything page (owner only): the rebuilds, the start form and the owner's
 * defaults at /craft, one rebuild at /craft/<id>. Without Craft Anything installed it
 * says so and links to its card instead of the start form.
 */
export default function CraftPage({
  route,
  onNavigate,
  openNavigation,
  navigationOpen,
  onLaunch,
}) {
  if (route.rebuildId)
    return (
      <RebuildDetail
        key={route.rebuildId}
        id={route.rebuildId}
        onNavigate={onNavigate}
        onLaunch={onLaunch}
      />
    );
  return (
    <RebuildsOverview
      onNavigate={onNavigate}
      openNavigation={openNavigation}
      navigationOpen={navigationOpen}
    />
  );
}

function RebuildsOverview({ onNavigate, openNavigation, navigationOpen }) {
  const { data, error, start, saveSettings } = useRebuilds();
  return (
    <SettingsShell
      className="craft-page"
      title={copy.title}
      description={copy.description}
      leading="menu"
      onLeading={openNavigation}
      navigationOpen={navigationOpen}
    >
      {!data ? (
        error ? (
          <ErrorMessage error={error} />
        ) : (
          <p className="loading" role="status">
            {copy.loading}
          </p>
        )
      ) : (
        <>
          {!data.installed && (
            <div className="craft-note craft-not-installed">
              <p>{copy.notInstalled}</p>
              <a
                className="button secondary"
                href={routePath(codingRoute("install"))}
                onClick={(event) => {
                  if (!isPlainClick(event)) return;
                  event.preventDefault();
                  onNavigate(codingRoute("install"));
                }}
              >
                {copy.openCraftAnything}
              </a>
            </div>
          )}
          <RebuildList rebuilds={data.rebuilds || []} onNavigate={onNavigate} />
          {data.installed && (
            <CraftStartForm
              data={data}
              start={start}
              onStarted={(view) => onNavigate(craftRoute(view.id))}
            />
          )}
          <CraftDefaults data={data} save={saveSettings} />
        </>
      )}
    </SettingsShell>
  );
}

function RebuildList({ rebuilds, onNavigate }) {
  const id = useId();
  return (
    <section className="craft-section" aria-labelledby={id}>
      <GroupLabel id={id}>{copy.list.title}</GroupLabel>
      {rebuilds.length === 0 ? (
        <p className="craft-note">{copy.list.empty}</p>
      ) : (
        <ListCard labelledBy={id}>
          {[...rebuilds].sort(byRecent).map((rebuild) => (
            <ListRow
              key={rebuild.id}
              label={rebuild.name || rebuild.request}
              sub={copy.list.sub(
                copy.steps[rebuild.step] ?? copy.steps.build,
                formatMessageTime(rebuild.updatedAt || rebuild.createdAt),
              )}
              status={{
                tone: statusTone(rebuild.status),
                text: copy.status[rebuild.status] ?? rebuild.statusLabel ?? "",
              }}
              href={routePath(craftRoute(rebuild.id))}
              onClick={() => onNavigate(craftRoute(rebuild.id))}
            />
          ))}
        </ListCard>
      )}
    </section>
  );
}

// The owner's defaults: account, mode and auto mode of new rebuilds, also those
// sessions and agents start. A small draft with its own Save.
function CraftDefaults({ data, save }) {
  const id = useId();
  const action = useAsyncAction();
  const saved = data.settings || {};
  const [draft, setDraft] = useState(null);
  const values = draft ?? saved;
  const accounts = data.accounts || [];
  const changed =
    draft !== null &&
    ["accountId", "mode", "autoMode"].some((key) => draft[key] !== saved[key]);
  const set = (key) => (value) => setDraft({ ...values, [key]: value });
  const submit = (event) => {
    event.preventDefault();
    action.run(async () => {
      await save({
        accountId: values.accountId || null,
        mode: values.mode,
        autoMode: values.autoMode === true,
      });
      setDraft(null);
    });
  };
  return (
    <section className="craft-section" aria-labelledby={id}>
      <GroupLabel id={id} hint={copy.defaults.hint}>
        {copy.defaults.title}
      </GroupLabel>
      <form onSubmit={submit} className="craft-defaults">
        <ListCard labelledBy={id}>
          {accounts.length > 0 && (
            <SelectRow
              label={copy.start.account}
              value={values.accountId ?? ""}
              onChange={set("accountId")}
              options={accountOptions(accounts)}
            />
          )}
          <div className="list-row craft-choice-row">
            <span className="list-row-label" aria-hidden="true">
              {copy.start.mode}
            </span>
            <Segmented
              label={copy.start.mode}
              value={values.mode ?? "clean-room"}
              onChange={set("mode")}
              options={modeOptions()}
            />
          </div>
          <ToggleRow
            label={copy.start.autoMode}
            checked={values.autoMode === true}
            onChange={set("autoMode")}
          />
        </ListCard>
        <ErrorMessage error={action.error} />
        <div className="craft-actions">
          <button
            type="submit"
            className="button secondary"
            disabled={!changed || action.busy}
          >
            {action.busy ? copy.defaults.saving : copy.defaults.save}
          </button>
        </div>
      </form>
    </section>
  );
}
