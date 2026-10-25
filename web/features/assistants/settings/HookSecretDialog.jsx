import React from "react";
import CodeBlock from "../../../components/CodeBlock.jsx";
import CopyButton from "../../../components/CopyButton.jsx";
import Modal from "../../../components/Modal.jsx";
import { hookCopy as copy } from "../../../lib/i18n/messages/assistant-hooks.js";
import { curlSample } from "./hook-fields.js";

/**
 * The one-time reveal of a hook's new secret with a sample request. AgentPier keeps
 * only a hash, so once this closes the secret cannot be shown again.
 */
export default function HookSecretDialog({ secret, address, onClose }) {
  return (
    <Modal
      title={copy.secretTitle}
      close={onClose}
      className="agent-hook-secret"
      footer={
        <>
          <CopyButton text={secret} label={copy.copySecret} />
          <button type="button" className="button primary" onClick={onClose}>
            {copy.done}
          </button>
        </>
      }
    >
      <p>{copy.secretOnce}</p>
      <CodeBlock copyLabel={copy.copySecret}>{secret}</CodeBlock>
      <p>{copy.sample}</p>
      <CodeBlock copyLabel={copy.copySample}>{curlSample(secret, address)}</CodeBlock>
    </Modal>
  );
}
