import React, { useId } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { CheckboxRow, SelectRow, ToggleRow } from "../../../components/ListRow.jsx";
import Segmented from "../../../components/Segmented.jsx";
import { hookCopy as copy } from "../../../lib/i18n/messages/assistant-hooks.js";
import { assistantShellCopy as shellCopy } from "../../../lib/i18n/messages/assistant-shell.js";
import { setFolderLevel, toggleId } from "./agent-settings-fields.js";
import { hookTicks } from "./hook-fields.js";

const union = (a, b) => [...new Set([...a, ...b])];
const nameOf = (items, id) => items?.find((item) => item.id === id)?.name || id;

// Why a tick cannot be switched on; null when the agent holds the right.
function tickReason(key, ceiling, values) {
  if (key === "notify") return null;
  if (ceiling[key] !== true) return copy.missing[key];
  if (key === "telegram" && !values.notify) return copy.telegramNeedsNotify;
  return null;
}

/**
 * A hook's rights, each capped by what the agent holds now (`hook.ceiling`). A right
 * the agent has lost since keeps its saved value but shows disabled with the reason,
 * so saving other fields sends it back unchanged.
 */
export default function HookRights({ hook, values, set, disabled, catalog }) {
  const ticksId = useId(),
    shellId = useId(),
    sshId = useId(),
    foldersId = useId();
  const { ceiling } = hook;
  const shellOptions = union(hook.shellChoices, [values.shell]);
  const shellChanged =
    values.shell === hook.rights.shell && hook.effective.shell !== hook.rights.shell;
  const hosts = union(ceiling.sshHosts, values.sshHosts);
  const folders = union(Object.keys(ceiling.folders), Object.keys(values.folders));
  return (
    <>
      <section aria-labelledby={ticksId}>
        <GroupLabel id={ticksId}>{copy.rights}</GroupLabel>
        <ListCard labelledBy={ticksId}>
          {hookTicks.map((key) => {
            const reason = tickReason(key, ceiling, values);
            return (
              <ToggleRow
                key={key}
                label={copy.ticks[key]}
                sub={reason || copy.tickHints[key]}
                checked={values[key] === true}
                disabled={disabled || Boolean(reason)}
                onChange={(next) => set(key, next)}
              />
            );
          })}
        </ListCard>
      </section>
      <section aria-labelledby={shellId}>
        <GroupLabel id={shellId}>{copy.shell}</GroupLabel>
        <ListCard labelledBy={shellId}>
          <div className="list-row agent-shell-levels">
            <Segmented
              label={copy.shell}
              options={shellOptions.map((value) => ({
                value,
                label: shellCopy.levels[value],
              }))}
              value={values.shell}
              disabled={disabled || shellOptions.length < 2}
              onChange={(next) => set("shell", next)}
            />
          </div>
          {shellOptions.length < 2 && <p className="agent-row-note">{copy.shellNone}</p>}
          {shellChanged && (
            <p className="agent-row-note">
              {copy.shellChanged(shellCopy.levels[hook.effective.shell])}
            </p>
          )}
        </ListCard>
      </section>
      <section aria-labelledby={sshId}>
        <GroupLabel id={sshId}>{copy.sshHosts}</GroupLabel>
        <ListCard labelledBy={sshId}>
          {!hosts.length && <p className="agent-row-note">{copy.sshNone}</p>}
          {hosts.map((host) => {
            const gone = !ceiling.sshHosts.includes(host);
            return (
              <CheckboxRow
                key={host}
                label={nameOf(catalog?.sshHosts, host)}
                sub={gone ? copy.sshGone : undefined}
                checked={values.sshHosts.includes(host)}
                disabled={disabled || gone}
                onChange={(on) => set("sshHosts", toggleId(values.sshHosts, host, on))}
              />
            );
          })}
        </ListCard>
      </section>
      <section aria-labelledby={foldersId}>
        <GroupLabel id={foldersId}>{copy.folders}</GroupLabel>
        <ListCard labelledBy={foldersId}>
          {!folders.length && <p className="agent-row-note">{copy.foldersNone}</p>}
          {folders.map((project) => {
            const allowed = ceiling.folders[project];
            const level = values.folders[project] || "none";
            const levels = ["none", "read"];
            if (allowed === "write" || level === "write") levels.push("write");
            return (
              <SelectRow
                key={project}
                label={nameOf(catalog?.projects, project)}
                sub={
                  !allowed
                    ? copy.folderGone
                    : allowed === "read"
                      ? copy.folderReadOnly
                      : undefined
                }
                value={level}
                options={levels.map((value) => ({
                  value,
                  label: copy.folderLevels[value],
                }))}
                disabled={disabled || !allowed}
                onChange={(next) =>
                  set("folders", setFolderLevel(values.folders, project, next))
                }
              />
            );
          })}
        </ListCard>
      </section>
    </>
  );
}
