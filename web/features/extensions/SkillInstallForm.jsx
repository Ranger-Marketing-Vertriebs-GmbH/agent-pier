import { MAX_FILE } from "./extensionInputs.js";
import { useProfileExtensionsCopy as validationCopy } from "../../lib/i18n/messages/extensions.js";
import { useId, useState, useRef } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Segment from "../../components/Segment.jsx";
import SidePanel from "../../components/SidePanel.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { skillInstallFormCopy as copy } from "../../lib/i18n/messages/extensions.js";
import { skillScanCopy as scanCopy } from "../../lib/i18n/messages/skill-scan.js";
import { fileContent } from "./extensionInputs.js";
import SkillScanPreview, { needsAcceptance } from "./SkillScanPreview.jsx";
import React from "react";

/**
 * Checks a skill upload or GitHub link and installs the scanned preview. The defaults
 * install into a CLI profile (`endpoint`, `data.skills.installPath`); the agent skill
 * catalog passes its own `paths`, a `destination` text with its label, `title`,
 * `installLabel`, `initialPreview` when an update check already returned one, and
 * `previewFields` sent with every check (the catalog skill an upload updates).
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
      setPreview(result);
    } catch (error) {
      if (alive.current) setError(error.message);
    } finally {
      if (alive.current) setChecking(false);
    }
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
        // The panel closes on success; the next one starts with an empty draft.
        if (alive.current) close();
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
            <p className="field-description extension-wide">
              {copy.archiveLimitsDescription}
            </p>
          </fieldset>
        </form>
      )}
    </SidePanel>
  );
}
