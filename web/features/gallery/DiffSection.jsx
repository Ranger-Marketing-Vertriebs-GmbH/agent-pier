import React, { useState } from "react";
import DiffReview from "../../components/diff/DiffReview.jsx";
import { galleryCopy as copy } from "../../lib/i18n/messages/gallery.js";
import { GallerySection, Specimen } from "./GallerySection.jsx";
import { REVIEW_WORKSPACE, reviewComments, reviewFiles } from "./gallery-fixtures.js";

// DiffReview on fixture data: the editable specimen keeps its comments in state,
// nothing is sent to a server.
export default function DiffSection() {
  const [comments, setComments] = useState(reviewComments);
  const [counter, setCounter] = useState(1);
  const stamp = () => new Date().toISOString();
  return (
    <GallerySection id="diff">
      <Specimen label={`DiffReview · ${copy.diff.editable}`} wide>
        <div data-specimen="diff-review">
          <DiffReview
            files={reviewFiles}
            comments={comments}
            workspace={REVIEW_WORKSPACE}
            onCreate={async (input) => {
              setCounter((value) => value + 1);
              setComments((list) => [
                ...list,
                {
                  ...input,
                  id: `local-${counter}`,
                  status: "open",
                  createdAt: stamp(),
                  updatedAt: stamp(),
                },
              ]);
            }}
            onUpdate={async (id, patch) =>
              setComments((list) =>
                list.map((item) =>
                  item.id === id ? { ...item, ...patch, updatedAt: stamp() } : item,
                ),
              )
            }
            onDelete={async (id) =>
              setComments((list) => list.filter((item) => item.id !== id))
            }
          />
        </div>
      </Specimen>
      <Specimen label={`DiffReview · ${copy.diff.readOnly}`} wide>
        <div data-specimen="diff-read-only">
          <DiffReview
            files={reviewFiles.slice(0, 1)}
            comments={reviewComments().filter((item) => item.file === "server/a.js")}
            workspace={REVIEW_WORKSPACE}
            readOnly
          />
        </div>
      </Specimen>
    </GallerySection>
  );
}
