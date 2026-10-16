import React, { useId, useRef, useState } from "react";
import { routePath } from "../../../app/routes.js";
import { mcpDirectoryCopy as copy } from "../../../lib/i18n/messages/mcp-directory.js";
import { tabRoot } from "../../settings/settings-navigation.js";
import DirectoryDetail from "./DirectoryDetail.jsx";
import DirectoryResult from "./DirectoryResult.jsx";
import { directoryApi } from "./directory-api.js";
import { draftFromEntry } from "./directory-draft.js";
import useDirectoryStatus from "./useDirectoryStatus.js";
import WizardStep from "./WizardStep.jsx";

const settingsRoute = tabRoot("workspace");
const idle = { phase: "idle", entries: [], cursor: null, error: null };

/** "Directory turned off" links to Settings → Workspace, where it is switched on. */
export function SettingsLink({ navigate }) {
  return (
    <a
      href={routePath(settingsRoute)}
      onClick={(event) => {
        event.preventDefault();
        navigate(settingsRoute);
      }}
    >
      {copy.openSettings}
    </a>
  );
}

function statusText(state, shown) {
  if (state.phase === "idle") return copy.emptyHint;
  if (state.phase === "loading") return copy.loading;
  return state.phase === "done" && shown.length ? copy.results(shown.length) : "";
}

/** Search the MCP Registry; a hit opens its detail; "Use this server" fills the draft. */
export default function DirectoryStep({ dispatch, go, headingRef, data, navigate }) {
  const id = useId();
  const directory = useDirectoryStatus();
  const [term, setTerm] = useState("");
  const [filter, setFilter] = useState("installable");
  const [state, setState] = useState(idle);
  const [detail, setDetail] = useState(null);
  // Only the latest search or detail request may change the screen.
  const latest = useRef(0);
  // What "Try again" repeats: the failed search, page or detail.
  const retry = useRef(null);
  const fail = (ticket) => (error) => {
    if (ticket === latest.current)
      setState((current) => ({ ...current, phase: "failed", error }));
  };
  const run = async (cursor = "", search = cursor ? state.search : term.trim()) => {
    const ticket = ++latest.current;
    retry.current = () => run(cursor, search);
    setState((current) => ({
      ...(cursor ? current : idle),
      search,
      phase: "loading",
      error: null,
    }));
    try {
      const page = await directoryApi.search(search, cursor);
      if (ticket !== latest.current) return;
      setState((current) => ({
        search,
        phase: "done",
        entries: cursor ? [...current.entries, ...page.entries] : page.entries,
        cursor: page.nextCursor,
        error: null,
      }));
    } catch (error) {
      fail(ticket)(error);
    }
  };
  const open = async (entry) => {
    const ticket = ++latest.current;
    retry.current = () => open(entry);
    try {
      const found = await directoryApi.detail(entry.name);
      if (ticket === latest.current) setDetail(found);
    } catch (error) {
      fail(ticket)(error);
    }
  };
  const use = (option) => {
    const taken = (data.mcpServers || []).map((server) => server.name);
    const draft = draftFromEntry(detail, option, { taken });
    setDetail(null);
    dispatch({ type: "fromDirectory", draft });
    go(draft.path === "remote" && draft.urlTemplate ? "remote" : "settings");
  };
  const shown = state.entries.filter((entry) => filter === "all" || entry.installable);
  const disabled = state.error?.code === "MCP_DIRECTORY_DISABLED";
  return (
    <>
      <WizardStep
        title={copy.title}
        headingRef={headingRef}
        onSubmit={() => term.trim() && run()}
      >
        <p className="mcp-hint">{copy.helper(directory.status?.host ?? "")}</p>
        <div className="mcp-directory-search">
          <label htmlFor={`${id}-search`}>{copy.searchLabel}</label>
          <input
            id={`${id}-search`}
            type="search"
            value={term}
            maxLength={100}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setTerm(event.target.value)}
          />
          <button type="submit" className="button secondary">
            {copy.searchButton}
          </button>
        </div>
        <div className="mcp-directory-filters" role="group" aria-label={copy.filters}>
          {[
            ["installable", copy.installable],
            ["all", copy.all],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="button secondary"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <p role="status" className="mcp-hint">
          {statusText(state, shown)}
        </p>
        {state.phase === "loading" && !state.entries.length && (
          <div aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <div key={index} className="mcp-directory-skeleton" />
            ))}
          </div>
        )}
        {state.phase === "failed" && (
          <div role="alert" className="mcp-field-error mcp-directory-error">
            {disabled ? copy.turnedOff : copy.failed}{" "}
            {disabled ? (
              <SettingsLink navigate={navigate} />
            ) : (
              <button
                type="button"
                className="button secondary"
                onClick={() => retry.current?.()}
              >
                {copy.tryAgain}
              </button>
            )}
          </div>
        )}
        {state.phase === "done" && !shown.length && (
          <div className="mcp-wizard-notice mcp-directory-nohit">
            <p>{copy.noHit}</p>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                dispatch({ type: "choose", path: "package" });
                go("package");
              }}
            >
              {copy.noHitPackage}
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                dispatch({ type: "via", via: "paste" });
                go("paste");
              }}
            >
              {copy.noHitPaste}
            </button>
          </div>
        )}
        {shown.length > 0 && (
          <div className="mcp-directory-results">
            {shown.map((entry) => (
              <DirectoryResult
                key={entry.name}
                entry={entry}
                onOpen={() => open(entry)}
              />
            ))}
          </div>
        )}
        {state.cursor && state.phase === "done" && (
          <button
            type="button"
            className="button secondary"
            onClick={() => run(state.cursor)}
          >
            {copy.showMore}
          </button>
        )}
      </WizardStep>
      <DirectoryDetail entry={detail} onUse={use} onClose={() => setDetail(null)} />
    </>
  );
}
