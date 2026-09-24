import { MAX_FILE } from "./extensionInputs.js";
import { useProfileExtensionsCopy as validationCopy } from "../../lib/i18n/messages/extensions.js";
import { useId, useState, useRef } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Segment from "../../components/Segment.jsx";
import SidePanel from "../../components/SidePanel.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { skillInstallFormCopy as copy } from "../../lib/i18n/messages/extensions.js";
import { fileContent } from "./extensionInputs.js";
import React from "react";
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
}) {
  const formId = useId();
  const [source, setSource] = useState("file");
  const [file, setFile] = useState(null);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef(null);
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
  return (
    <SidePanel
      title={commonCopy.installSkill}
      subtitle={subtitle}
      close={close}
      closeDisabled={Boolean(busy)}
      footer={
        <button
          className="button primary"
          form={formId}
          disabled={Boolean(busy) || (source === "file" && !file)}
        >
          {busy === "skill" ? copy.installingSkill : commonCopy.installSkill}
        </button>
      }
    >
      <form
        id={formId}
        className="extension-panel-form"
        onSubmit={(event) => {
          event.preventDefault();
          mutate(
            "skill",
            async () => {
              let body;
              if (source === "url")
                body = {
                  url: downloadUrl.trim(),
                };
              else {
                if (!file) throw new Error(copy.fileRequired);
                body = {
                  fileName: file.name,
                  contentBase64: await fileContent(file),
                };
              }
              await request(`${endpoint}/skills`, "POST", body);
              // The panel closes on success; the next one starts with an empty draft.
              if (alive.current) close();
            },
            copy.installedNotice,
          );
        }}
      >
        <fieldset className="extension-fields" disabled={Boolean(busy)}>
          <ErrorMessage error={error} as="p" className="error extension-wide" />
          <div className="extension-field extension-wide">
            <span>{copy.destinationLabel}</span>
            <code className="extension-path">{data.skills.installPath}</code>
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
              />
            </label>
          )}
          <p className="field-description extension-wide">
            {copy.archiveLimitsDescription}
          </p>
        </fieldset>
      </form>
    </SidePanel>
  );
}
