import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";

const limit = 1024 * 1024;
const certificate = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * The CA bundle uv trusts like Node does: Node's bundled roots plus the certificates
 * of NODE_EXTRA_CA_CERTS (a company CA behind a TLS-intercepting proxy), written 0600
 * into the run's private `work` folder, which is removed after every run. Null when
 * that variable is unset or its file is unusable; uv then keeps its own roots
 * (docs/installation.md). `tls.rootCertificates` leaves out the operating system's
 * store even when Node runs with --use-system-ca (tls.getCACertificates needs Node
 * 22.15+), so such a CA must also be listed in NODE_EXTRA_CA_CERTS.
 */
export function uvCertificateFile(
  work,
  environment = process.env,
  { roots = tls.rootCertificates } = {},
) {
  const extra = environment?.NODE_EXTRA_CA_CERTS;
  if (typeof extra !== "string" || !extra) return null;
  let found;
  try {
    const stat = fs.statSync(extra);
    if (!stat.isFile() || stat.size > limit) throw Error("unusable");
    found = fs.readFileSync(extra, "utf8").match(certificate) ?? [];
    if (!found.length) throw Error("no certificate");
  } catch {
    // Without the path: the log may be shared.
    console.error(
      "AgentPier could not pass NODE_EXTRA_CA_CERTS to uv (unreadable or no certificate).",
    );
    return null;
  }
  const file = path.join(work, "ca-bundle.pem");
  fs.writeFileSync(file, `${[...roots, ...found].join("\n")}\n`, { mode: 0o600 });
  return file;
}
