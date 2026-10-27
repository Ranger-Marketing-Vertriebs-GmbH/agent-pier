import { useCallback, useEffect, useRef, useState } from "react";
import { agentSkillCatalogCopy as copy } from "../../../lib/i18n/messages/agent-skill-catalog.js";
import { assistantApi } from "../assistant-api.js";

/**
 * The owner's skill catalog (Agents › Skills): the list, one action at a time
 * (`busy`), its notice or error, and the install panel. `panel` is null, `{ skill }`
 * for a new skill (`skill` null) or a new version, plus `preview` when an update
 * check already returned one. `mutate` matches SkillInstallForm's contract: it runs
 * the action, reloads the list and shows `success`.
 */
export default function useSkillCatalog() {
  const [skills, setSkills] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [panel, setPanel] = useState(null);
  const [removing, setRemoving] = useState(null);
  const alive = useRef(true);
  const lock = useRef(false);
  const load = useCallback(async (signal) => {
    try {
      const result = await assistantApi.skillCatalog(signal);
      if (!signal?.aborted && alive.current) {
        setSkills(Array.isArray(result?.skills) ? result.skills : []);
        setLoadError("");
      }
    } catch (failure) {
      if (!signal?.aborted && alive.current) setLoadError(failure.message);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    load(controller.signal);
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, [load]);
  async function mutate(kind, action, success) {
    if (lock.current) return;
    lock.current = true;
    setBusy(kind);
    setError("");
    setNotice("");
    try {
      await action();
      if (!alive.current) return;
      await load();
      if (alive.current) setNotice(success);
    } catch (failure) {
      if (alive.current) setError(failure.message);
    } finally {
      lock.current = false;
      if (alive.current) setBusy("");
    }
  }
  /** Downloads a GitHub skill again: a notice when up to date, else its preview. */
  function checkUpdate(skill) {
    if (lock.current) return;
    lock.current = true;
    setBusy("check");
    setError("");
    setNotice(copy.checking(skill.name));
    assistantApi
      .checkCatalogSkill(skill.id)
      .then((result) => {
        if (!alive.current) return;
        if (result?.upToDate) setNotice(copy.upToDate(skill.name));
        else {
          setNotice("");
          setPanel({ skill, preview: result });
        }
      })
      .catch((failure) => {
        if (!alive.current) return;
        setNotice("");
        setError(failure.message);
      })
      .finally(() => {
        lock.current = false;
        if (alive.current) setBusy("");
      });
  }
  /** Removes `removing` after the confirmation; the dialog shows a failure itself. */
  async function remove() {
    const skill = removing;
    setError("");
    setNotice("");
    await assistantApi.removeCatalogSkill(skill.id);
    if (!alive.current) return;
    setRemoving(null);
    setNotice(copy.removedNotice(skill.name));
    await load();
  }
  return {
    skills,
    loadError,
    error,
    setError,
    notice,
    busy,
    alive,
    mutate,
    panel,
    openPanel: (skill = null) => {
      setError("");
      setNotice("");
      setPanel({ skill });
    },
    closePanel: () => {
      setError("");
      setPanel(null);
    },
    checkUpdate,
    removing,
    setRemoving,
    remove,
  };
}
