import React from "react";
import Icon, { iconNames } from "../../components/Icon.jsx";
import ProviderMark from "../../components/ProviderMark.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { galleryCopy as copy } from "../../lib/i18n/messages/gallery.js";
import { GallerySection, Specimen } from "./GallerySection.jsx";

const variants = ["primary", "secondary", "danger", "destructive", "text"];

export default function ActionsSection() {
  return (
    <GallerySection id="actions">
      {variants.map((variant) => (
        <Specimen key={variant} label={`.button.${variant}`}>
          <button type="button" className={`button ${variant}`}>
            {copy.variants[variant]}
          </button>
          <button type="button" className={`button ${variant} compact`}>
            {copy.variants.compact}
          </button>
          <button type="button" className={`button ${variant}`} disabled>
            {copy.variants.disabled}
          </button>
        </Specimen>
      ))}
      <Specimen label={`.icon-button · ${copy.variants.iconButton}`}>
        <button type="button" className="icon-button" aria-label={commonCopy.closeDialog}>
          <Icon name="close" />
        </button>
        <button type="button" className="icon-button" aria-label={commonCopy.delete}>
          <Icon name="trash" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={commonCopy.moreActions}
          disabled
        >
          <Icon name="more" />
        </button>
      </Specimen>
      <Specimen label={`Icon · ${copy.variants.icons}`} wide>
        <ul className="gallery-icons">
          {iconNames.map((name) => (
            <li key={name}>
              <Icon name={name} />
              <code>{name}</code>
            </li>
          ))}
        </ul>
      </Specimen>
      <Specimen label={`ProviderMark · ${copy.variants.providerMarks}`}>
        {["codex", "claude", "opencode", "terminal"].map((tool) => (
          <ProviderMark key={tool} tool={tool} label={tool} />
        ))}
        {["codex", "claude"].map((tool) => (
          <ProviderMark key={`${tool}-small`} tool={tool} small />
        ))}
      </Specimen>
    </GallerySection>
  );
}
