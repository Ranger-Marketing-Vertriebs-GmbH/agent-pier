import { MAX_FILE } from "./extensionInputs.js";
import { useProfileExtensionsCopy as validationCopy } from "../../lib/i18n/messages/extensions.js";
import { useId, useState, useRef } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Segment from "../../components/Segment.jsx";
import SidePanel from "../../components/SidePanel.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { skillInstallFormCopy as copy } from "../../lib/i18n/messages/extensions.js";
import {
  skillCollectionCopy as collectionCopy,
  skillScanCopy as scanCopy,
} from "../../lib/i18n/messages/skill-scan.js";
import { fileContent } from "./extensionInputs.js";
import SkillCollection, { offered, selectable } from "./SkillCollection.jsx";
import SkillScanPreview, { needsAcceptance } from "./SkillScanPreview.jsx";
import React from "react";

/**
 * Checks a skill upload or GitHub link and installs the scanned preview. The defaults
 * install into a CLI profile (`endpoint`, `data.skills.installPath`); the agent skill
 * catalog passes its own `paths`, a `destination` text with its label, `title`,
 * `installLabel`, `initialPreview` when an update check already returned one, and
 * `previewFields` sent with every check (the catalog skill an upload updates). With
 * `paths.collection` (the catalog) a source that holds several skills answers a
 * collection: the owner picks skills there (SkillCollection), the ones without
 * findings install together and one with findings opens its own preview.
 */
export default function SkillInstallForm({
  mutate,
  request,
  endpoint,
  alive,
  data,
  busy,
  error,
  setError,
  subtitle,
  close,
  paths = {
    preview: `${endpoint}/skills/preview`,
    install: `${endpoint}/skills`,
  },
  destination,
  destinationLabel = copy.destinationLabel,
  title = commonCopy.installSkill,
  installLabel = commonCopy.installSkill,
  successNotice = copy.installedNotice,
  initialPreview = null,
  previewFields = null,
  limitsDescription = copy.archiveLimitsDescription,
}) {
  const formId = useId();
  const [source, setSource] = useState("file");
  const [file, setFile] = useState(null);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef(null);
  // The scan of the chosen source; installing confirms exactly this preview.
  const [preview, setPreview] = useState(initialPreview);
  const [accepted, setAccepted] = useState(false);
  const [checking, setChecking] = useState(false);
  // A checked source with several skills: the picked folders, the ones added so far,
  // the refusals of the last install and the folder whose preview is open.
  const [collection, setCollection] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [added, setAdded] = useState(() => new Set());
  const [skipped, setSkipped] = useState(() => new Map());
  const [reviewing, setReviewing] = useState(null);
  const collectionPath = collection && paths.collection?.(collection.collectionId);
  const working = Boolean(busy) || checking;
  function chooseFile(next) {
    if (!next) return;
    if (next.size > MAX_FILE) {
      setError(validationCopy.fileTooLarge);
      return;
    }
    if (next.name !== "SKILL.md" && !next.name.toLowerCase().endsWith(".zip")) {
      setError(validationCopy.unsupportedFileType);
      return;
    }
    setFile(next);
    setError("");
  }
  async function check(event) {
    event.preventDefault();
    if (working) return;
    setChecking(true);
    setError("");
    try {
      let body;
      if (source === "url") body = { url: downloadUrl.trim() };
      else {
        if (!file) throw new Error(copy.fileRequired);
        body = { fileName: file.name, contentBase64: await fileContent(file) };
      }
      const result = await request(paths.preview, "POST", { ...body, ...previewFields });
      if (!alive.current) return;
      setAccepted(false);
      if (result?.collection) {
        setCollection(result.collection);
        setPicked(
          new Set(
            result.collection.skills.filter(selectable).map((skill) => skill.folder),
          ),
        );
        setAdded(new Set());
        setSkipped(new Map());
      } else setPreview(result);
    } catch (error) {
      if (alive.current) setError(error.message);
    } finally {
      if (alive.current) setChecking(false);
    }
  }
  /** Keeps the panel open while the source still offers a skill that is not added. */
  function afterAdded(folders) {
    const next = new Set([...added, ...folders]);
    if (collection.skills.some((skill) => offered(skill) && !next.has(skill.folder))) {
      setAdded(next);
      return true;
    }
    close();
    return false;
  }
  /** Opens the full preview of one skill of the collection. */
  async function review(folder) {
    if (working) return;
    setChecking(true);
    setError("");
    try {
      const result = await request(`${collectionPath}/preview`, "POST", { folder });
      if (!alive.current) return;
      setAccepted(false);
      setReviewing(folder);
      setPreview(result);
    } catch (error) {
      if (alive.current) setError(error.message);
    } finally {
      if (alive.current) setChecking(false);
    }
  }
  function installPicked() {
    let outcome = { installed: [], skipped: [] };
    mutate(
      "skill",
      async () => {
        outcome = await request(`${collectionPath}/skills`, "POST", {
          skills: collection.skills
            .filter((skill) => picked.has(skill.folder))
            .map(({ folder, contentHash }) => ({ folder, contentHash })),
        });
        if (!alive.current) return;
        setPicked(new Set());
        setSkipped(new Map(outcome.skipped.map((skip) => [skip.folder, skip.problem])));
        afterAdded(outcome.installed.map((result) => result.folder));
      },
      () =>
        collectionCopy.installedNotice(outcome.installed.length, outcome.skipped.length),
    );
  }
  function install(decision = {}) {
    mutate(
      "skill",
      async () => {
        await request(paths.install, "POST", {
          previewId: preview.previewId,
          contentHash: preview.contentHash,
          ...(preview.verdict === "warn" ? { acceptWarnings: accepted } : {}),
          ...decision,
        });
        if (!alive.current) return;
        // The panel closes on success; the next one starts with an empty draft. A
        // skill reviewed from a collection goes back to the other skills instead.
        if (collection && reviewing) {
          if (afterAdded([reviewing])) setPreview(null);
        } else close();
      },
      successNotice,
    );
  }
  const footer = preview ? (
    <>
      <button
        type="button"
        className="button secondary"
        disabled={working}
        onClick={() => {
          setPreview(null);
          setError("");
        }}
      >
        {scanCopy.backAction}
      </button>
      {preview.verdict !== "block" && (
        <button
          type="button"
          className="button primary"
          disabled={working || (needsAcceptance(preview) && !accepted)}
          onClick={() => install()}
        >
          {busy === "skill" ? copy.installingSkill : installLabel}
        </button>
      )}
    </>
  ) : collection ? (
    <>
      <button
        type="button"
        className="button secondary"
        disabled={working}
        onClick={() => {
          setCollection(null);
          setError("");
        }}
      >
        {scanCopy.backAction}
      </button>
      <button
        type="button"
        className="button primary"
        disabled={working || !picked.size}
        onClick={installPicked}
      >
        {busy === "skill"
          ? collectionCopy.installing
          : collectionCopy.installAction(picked.size)}
      </button>
    </>
  ) : (
    <button
      className="button primary"
      form={formId}
      disabled={working || (source === "file" && !file)}
    >
      {checking ? scanCopy.checking : scanCopy.checkAction}
    </button>
  );
  return (
    <SidePanel
      title={title}
      subtitle={subtitle}
      close={close}
      closeDisabled={working}
      footer={footer}
    >
      {preview ? (
        <>
          <ErrorMessage error={error} as="p" className="error" />
          <SkillScanPreview
            preview={preview}
            accepted={accepted}
            setAccepted={setAccepted}
            busy={working}
            onInstall={install}
          />
        </>
      ) : collection ? (
        <>
          <ErrorMessage error={error} as="p" className="error" />
          {checking && <p role="status">{collectionCopy.reviewing}</p>}
          <SkillCollection
            collection={collection}
            picked={picked}
            setPicked={setPicked}
            added={added}
            skipped={skipped}
            busy={working}
            onReview={review}
          />
        </>
      ) : (
        <form id={formId} className="extension-panel-form" onSubmit={check}>
          <fieldset className="extension-fields" disabled={working}>
            <ErrorMessage error={error} as="p" className="error extension-wide" />
            <div className="extension-field extension-wide">
              <span>{destinationLabel}</span>
              {destination ? (
                <span>{destination}</span>
              ) : (
                <code className="extension-path">{data.skills.installPath}</code>
              )}
            </div>
            <div className="extension-field extension-wide">
              <span aria-hidden="true">{commonCopy.skillSource}</span>
              <Segment
                label={commonCopy.skillSource}
                value={source}
                onChange={setSource}
                options={[
                  { value: "file", label: copy.uploadSource },
                  { value: "url", label: copy.githubSource },
                ]}
              />
            </div>
            {source === "file" ? (
              <div
                className={`extension-drop extension-wide ${dragging ? "dragging" : ""}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  if (!busy) setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  if (busy) return;
                  if (event.dataTransfer.files.length !== 1) {
                    setError(copy.extensionFieldsOnDrop);
                    return;
                  }
                  chooseFile(event.dataTransfer.files[0]);
                }}
              >
                <label>
                  {commonCopy.skillFile}
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".zip,.md"
                    onChange={(event) => chooseFile(event.target.files[0])}
                  />
                </label>
                <p>
                  {file
                    ? `${file.name} · ${Math.ceil(file.size / 1024)} KiB`
                    : copy.extensionFieldsDescription}
                </p>
              </div>
            ) : (
              <label className="extension-wide">
                {copy.extensionWide}
                <input
                  type="url"
                  required
                  value={downloadUrl}
                  onChange={(event) => setDownloadUrl(event.target.value)}
                  placeholder="https://github.com/owner/repo/tree/main/skill"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-describedby={`${formId}-ref`}
                />
              </label>
            )}
            {source === "url" && (
              <p id={`${formId}-ref`} className="field-description extension-wide">
                {copy.githubRefHint}
              </p>
            )}
            <p className="field-description extension-wide">{limitsDescription}</p>
          </fieldset>
        </form>
      )}
    </SidePanel>
  );
}
