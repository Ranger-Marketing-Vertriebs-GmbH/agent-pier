/* global window, setTimeout */
import { createElement as h, useEffect, useRef, useState } from "react";
import useTabDraft from "../../../../web/lib/settings/useTabDraft.js";
import useUnsavedChangesGuard from "../../../../web/lib/settings/useUnsavedChangesGuard.js";
import { requestNavigation } from "../../../../web/lib/navigation-guard.js";
import ListCard from "../../../../web/components/ListCard.jsx";
import { NumberRow, ToggleRow } from "../../../../web/components/ListRow.jsx";
import SaveBar from "../../../../web/components/SaveBar.jsx";
import Sheet from "../../../../web/components/Sheet.jsx";
import UnderlineTabs from "../../../../web/components/UnderlineTabs.jsx";
import UnsavedChangesSheet from "../../../../web/components/UnsavedChangesSheet.jsx";

const conflict = () =>
  Object.assign(new Error("Die Daten wurden inzwischen geändert."), {
    status: 409,
    messageKey: "assistants.conflict",
  });

// Test controls exist before the first render; the spec flips them per case.
window.harness = {
  failTeam: false,
  restart: false,
  restartTeam: false,
  trimName: false,
  delay: 0,
  calls: { agent: 0, team: 0, refresh: 0 },
  foreignChange: () => {},
  hiddenChange: () => {},
};

const restartRequired = () =>
  Object.assign(new Error("Neustart nötig"), {
    status: 409,
    code: "ASSISTANT_RESTART_REQUIRED",
    affected: { agents: [] },
  });
const fields = (record) => ({
  name: record.name,
  memory: record.memory,
  maxMembers: record.maxMembers,
});

export default function DraftFixture() {
  const [server, setServer] = useState({
    revision: 1,
    name: "Home",
    memory: false,
    maxMembers: 4,
  });
  const live = useRef(server);
  const [tab, setTab] = useState("profile");
  useEffect(() => {
    // A change made elsewhere: another field and a newer revision.
    window.harness.foreignChange = () => {
      live.current = {
        ...live.current,
        memory: !live.current.memory,
        revision: live.current.revision + 1,
      };
      setServer(live.current);
    };
    // A change elsewhere that this page only learns about through `refresh`.
    window.harness.hiddenChange = () => {
      live.current = {
        ...live.current,
        memory: !live.current.memory,
        revision: live.current.revision + 1,
      };
    };
  }, []);
  const commit = (next) => {
    live.current = next;
    setServer(next);
  };
  const draft = useTabDraft({
    server: fields(server),
    revisions: { agent: server.revision },
    refresh: async () => {
      window.harness.calls.refresh++;
      const fresh = live.current;
      setServer(fresh);
      return { server: fields(fresh), revisions: { agent: fresh.revision } };
    },
  });
  const steps = [
    {
      id: "agent",
      label: "Profil",
      keys: ["name", "memory"],
      resource: "agent",
      run: async ({ values, revision, confirmations }) => {
        window.harness.calls.agent++;
        if (window.harness.delay)
          await new Promise((resolve) => setTimeout(resolve, window.harness.delay));
        if (revision !== live.current.revision) throw conflict();
        if (window.harness.restart && !confirmations.confirmRestart)
          throw restartRequired();
        const next = {
          ...live.current,
          name: window.harness.trimName ? values.name.trim() : values.name,
          memory: values.memory,
          revision: live.current.revision + 1,
        };
        commit(next);
        return next;
      },
    },
    {
      id: "team",
      label: "Team",
      keys: ["maxMembers"],
      run: async ({ values, confirmations }) => {
        window.harness.calls.team++;
        if (window.harness.restartTeam && !confirmations.confirmRestart)
          throw restartRequired();
        if (window.harness.failTeam)
          throw new Error("Team konnte nicht gespeichert werden.");
        commit({ ...live.current, maxMembers: values.maxMembers });
        return {};
      },
    },
  ];
  const save = () => draft.save(steps);
  const sheet = useUnsavedChangesGuard({
    draft,
    tab: tab === "profile" ? "Profil" : "Team",
    save,
    stays: (request) => request.next?.tab === tab,
  });
  const select = (next) =>
    requestNavigation({
      reason: "application",
      next: { tab: next },
      commit: () => setTab(next),
    });
  return h(
    "main",
    { className: "harness" },
    h(UnderlineTabs, {
      label: "Draft tabs",
      tabs: [
        { id: "profile", label: "Profil" },
        { id: "team", label: "Team" },
      ],
      selected: tab,
      onSelect: select,
      idPrefix: "draft",
    }),
    h("p", { "data-testid": "tab" }, tab),
    h("p", { "data-testid": "server" }, JSON.stringify(server)),
    h(
      "label",
      null,
      "Name",
      h("input", {
        value: draft.values.name,
        onChange: (e) => draft.set("name", e.target.value),
      }),
    ),
    h(
      ListCard,
      { label: "Entwurf" },
      h(ToggleRow, {
        label: "Gedächtnis",
        checked: draft.values.memory,
        onChange: (value) => draft.set("memory", value),
      }),
      h(NumberRow, {
        label: "Mitglieder",
        value: draft.values.maxMembers,
        min: 1,
        max: 8,
        onChange: (value) => draft.set("maxMembers", value),
      }),
    ),
    h(SaveBar, {
      draft,
      onSave: save,
      onOverwrite: () => draft.overwrite(steps),
      note: "Startet 2 Agenten kurz neu.",
    }),
    h(UnsavedChangesSheet, sheet),
    h(
      Sheet,
      {
        open: Boolean(draft.confirmation),
        title: "Neustart bestätigen",
        onCancel: () => draft.confirmation?.cancel(),
      },
      h("p", { className: "sheet-body" }, draft.confirmation?.kind),
      h(
        "div",
        { className: "sheet-actions" },
        h(
          "button",
          {
            type: "button",
            className: "button primary",
            onClick: () => draft.confirmation.confirm(),
          },
          "Neu starten",
        ),
        h(
          "button",
          {
            type: "button",
            className: "button secondary",
            onClick: () => draft.confirmation.cancel(),
          },
          "Abbrechen",
        ),
      ),
    ),
  );
}
