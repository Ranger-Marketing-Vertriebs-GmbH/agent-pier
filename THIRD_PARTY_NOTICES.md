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

Koffi 3.3.2 and its `@koromix/koffi-*` platform packages are licensed under MIT.
Copyright (C) 2026 Niels Martignène. Their complete licenses and bundled component
notices are preserved in `node_modules/koffi/` and `node_modules/@koromix/`.
Versioned installation and update archives include the platform's optional native
package; release smoke checks load it and exercise descriptor reads, directory
enumeration, metadata preservation and atomic rename before activation.
Koffi uses these shipped prebuilts; its exact-version npm install script is disabled
in the project allowScripts policy. The reviewed node-pty 1.1.0 scripts remain
allowed for native compilation on platforms without a shipped prebuild. Older npm
versions may not enforce allowScripts; release validation always requires the
platform binary inside the staged archive.

SFTP access uses `ssh2` 1.17.0 (MIT, Copyright Brian White) with its dependencies
`asn1` 0.2.6 (MIT, Copyright (c) 2011 Mark Cavage), `bcrypt-pbkdf` 1.0.2
(BSD-3-Clause, Copyright 1997 Niels Provos, 2013 Ted Unangst and 2016 Joyent, Inc.),
`tweetnacl` 0.14.5 (Unlicense, public domain) and `safer-buffer` 2.1.2 (MIT, Copyright
(c) 2018 Nikita Skovoroda). Its optional `cpu-features` 0.0.10 and `buildcheck` 0.0.7
(MIT, Copyright Brian White) and `nan` 2.30.0 (MIT, Copyright (c) 2018 NAN
contributors) packages may be installed with it. Their licenses are preserved in
`node_modules`. AgentPier needs no native addon for `ssh2` and relies on its pure
JavaScript cryptography: the install scripts of `ssh2` 1.17.0 and `cpu-features` 0.0.10
are disabled in the project allowScripts policy. An npm version that does not enforce
allowScripts may still build their optional native bindings; `ssh2` then uses them, and
a failed build does not stop the installation.

## Email (IMAP and SMTP)

Agent email access uses `imapflow` 2.4.0 (MIT, Copyright (c) 2020-2024 Postal Systems
OÜ, <https://github.com/postalsys/imapflow>) for IMAP and `nodemailer`
10.1.0 (MIT-0, Copyright (c) 2011-2023 Andris Reinman,
<https://github.com/nodemailer/nodemailer>) for SMTP and message
composition. Both are pinned to exact versions and have no install scripts.
AgentPier always runs `imapflow` with logging turned off (`logger: false`), so
credentials and message content never reach its logger.

`imapflow` brings these runtime dependencies, each with its license preserved in
`node_modules`:

- `@zone-eu/mailsplit` 5.4.20 (MIT OR EUPL-1.1+, Copyright (c) 2011-2019, 2024 Andris
  Reinman and Zone Media OÜ), <https://github.com/zone-eu/mailsplit>; AgentPier uses
  it under the MIT license.
- `libmime` 5.4.7, `libqp` 2.1.2 and `libbase64` 1.3.2 (MIT, Copyright Andris
  Reinman), <https://github.com/nodemailer/libmime>,
  <https://github.com/nodemailer/libqp>, <https://github.com/nodemailer/libbase64>.
- `iconv-lite` 0.7.3 (MIT, Copyright (c) 2011 Alexander Shtuchkin) with `safer-buffer`
  2.1.2 (MIT), <https://github.com/pillarjs/iconv-lite>.
- `encoding-japanese` 2.4.0 (MIT, Copyright (c) 2012-present polygonplanet),
  <https://github.com/polygonplanet/encoding.js>.
- `socks` 2.8.10 (MIT, Copyright (c) 2013 Josh Glazebrook) with `ip-address` 10.7.4
  (MIT, Copyright (C) 2011 by Beau Gunderson) and `smart-buffer` 4.2.0 (MIT, Copyright
  (c) 2013-2017 Josh Glazebrook), <https://github.com/JoshGlazebrook/socks>.
- `pino` 10.3.1 (MIT, Copyright (c) 2016-2025 Matteo Collina, David Mark Clements and
  the Pino contributors), <https://github.com/pinojs/pino>, with its helpers
  `@pinojs/redact` 0.4.0, `atomic-sleep` 1.0.0, `on-exit-leak-free` 2.1.2,
  `pino-abstract-transport` 3.0.0, `pino-std-serializers` 7.1.0, `process-warning`
  5.1.1, `quick-format-unescaped` 4.0.4, `real-require` 0.2.0 and 1.0.0,
  `safe-stable-stringify` 2.5.0, `sonic-boom` 4.2.1 and `thread-stream` 4.2.0 (MIT) and
  `split2` 4.2.0 (ISC).

Tests use `smtp-server` 3.19.21 (MIT-0, Copyright (c) 2015-2025 Andris Reinman,
<https://github.com/nodemailer/smtp-server>) as a development
dependency with `punycode.js` 2.3.1 and `ipv6-normalize` 1.0.1 (MIT). It is not part
of installation or update packages.

## Fonts

The web interface bundles the DM Sans and Manrope fonts through
`@fontsource/dm-sans` 5.3.0 and `@fontsource/manrope` 5.3.0. The fonts are licensed
under the SIL Open Font License 1.1: DM Sans, Copyright 2014 The DM Sans Project
Authors; Manrope, Copyright 2019 The Manrope Project Authors. The complete license
texts are preserved in `node_modules/@fontsource/` and included in
`dist/third-party-licenses.txt` with the browser distribution.

## Managed agent runtime

The optional agent service is not bundled. When the owner turns agents on, AgentPier
downloads the pinned OpenClaw package (MIT) with its locked npm dependencies and
plugins, and a pinned Node.js runtime under the Node.js license, into the data
directory. Their license files stay inside that runtime installation; the locked
versions are listed in `server/features/assistants/runtime-lock/package-lock.json`.

## Unicode upload-name data

The pinned Unicode 15.1 data under `server/features/files/unicode-15.1/` is
distributed under the Unicode License V3. Its original attribution and complete
license are preserved in that directory. Installation and update archives include
the data and license with the server source. Upload name rejection uses this
versioned data as a product policy; it does not describe every filesystem's name
equivalence rules.

## Provider marks

The OpenAI glyph in `web/components/ProviderMark.jsx` comes from Simple Icons
13.0.0, `icons/openai.svg`, distributed under CC0-1.0:
<https://github.com/simple-icons/simple-icons/tree/13.0.0>.

Provider names and marks identify integrations. Their trademark rights remain
with their respective owners; AgentPier does not imply their endorsement.

## yazl

ZIP creation uses yazl 3.3.1 (MIT), Copyright (c) 2014 Josh Wolfe.
The locked runtime dependency and its MIT license are included in installation
and update packages. Source: https://github.com/thejoshwolfe/yazl/tree/3.3.1

## yauzl and buffer-crc32

ZIP extraction uses yauzl 3.4.0 (MIT), Copyright (c) 2014 Josh Wolfe, and the
direct buffer-crc32 1.0.0 dependency (MIT), Copyright (c) 2013-2024 Brian J.
Brennan. Their locked runtime packages and complete MIT license files are included
in installation and update packages. Sources:
https://github.com/thejoshwolfe/yauzl/tree/3.4.0 and
https://github.com/brianloveswords/buffer-crc32/tree/1.0.0

## CodeMirror editor

The optional text editor uses CodeMirror 6 (MIT), including state, view, commands,
search, language support, merge support, and the legacy Shell/TOML modes. The
pinned packages retain their complete MIT LICENSE files in the installed
distribution. The production browser distribution includes the complete license
and copyright notices for bundled CodeMirror and Lezer dependencies in
`dist/third-party-licenses.txt`; editor and language chunks load only when
requested. Merge support loads when the editor displays a revision conflict.
