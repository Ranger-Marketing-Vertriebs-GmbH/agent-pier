# Third-party notices

AgentPier is licensed under Apache-2.0. Copyright 2026 AgentPier contributors.
The project license does not replace the licenses of the components below.

## AgentBus

The bundled AgentBus source in `vendor/agentbus/` is licensed under MIT.
Copyright (c) 2026 David Kaulig. Its complete original license is preserved in
[`vendor/agentbus/LICENSE`](vendor/agentbus/LICENSE).

## Browser dependencies

The production build emits `dist/third-party-licenses.txt` with the license texts
and attribution of the dependencies actually included in the browser bundles.
It is also served at `/third-party-licenses.txt`. Keep that file with copies of
the browser distribution. The generated bundles refer to it in their banner.

## Node.js and server dependencies

Versioned release packages include the complete license and third-party notices
of their exact Node.js runtime as `third-party/node-LICENSE.txt`. This is extracted
from the same official, checksum-verified distribution as the executable.

Server dependencies retain their original license and attribution files inside
`node_modules`. The lockfile records exact dependency versions and their license
identifiers; those identifiers are an inventory, not a substitute for license texts.

In particular, `web-push` is MPL-2.0, and its covered source and license are included
in the distribution. Its MPL-covered files retain that license. `node-pty` retains
its MIT and bundled component notices. Other dependencies retain their own MIT,
Apache, ISC, BSD or other notices as supplied by their authors.

## Provider marks

The OpenAI glyph in `web/components/ProviderMark.jsx` comes from Simple Icons
13.0.0, `icons/openai.svg`, distributed under CC0-1.0:
<https://github.com/simple-icons/simple-icons/tree/13.0.0>.

Provider names and marks identify integrations. Their trademark rights remain
with their respective owners; AgentPier does not imply their endorsement.
