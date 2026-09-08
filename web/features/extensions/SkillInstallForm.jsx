import { MAX_FILE } from "./extensionInputs.js";
import { useProfileExtensionsCopy as validationCopy } from "../../lib/i18n/messages/extensions.js";
import { useState, useRef } from "react";
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
  setError,
}) {
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
    <form
      className="extension-install"
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
            if (alive.current) {
              setFile(null);
              setDownloadUrl("");
              if (fileInput.current) fileInput.current.value = "";
            }
          },
          copy.installedNotice,
        );
      }}
    >
      <h3>{commonCopy.installSkill}</h3>
      <p className="field-description">{copy.destinationLabel}</p>
      <code className="extension-path">{data.skills.installPath}</code>
      <fieldset className="extension-fields" disabled={Boolean(busy)}>
        <label className="extension-wide">
          {commonCopy.skillSource}
          <select
            aria-label={commonCopy.skillSource}
            value={source}
            onChange={(event) => setSource(event.target.value)}
          >
            <option value="file">{copy.uploadSource}</option>
            <option value="url">{copy.githubSource}</option>
          </select>
        </label>
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
      <div className="extension-actions">
        <button
          className="button primary"
          disabled={Boolean(busy) || (source === "file" && !file)}
        >
          {busy === "skill" ? copy.installingSkill : commonCopy.installSkill}
        </button>
      </div>
    </form>
  );
}
