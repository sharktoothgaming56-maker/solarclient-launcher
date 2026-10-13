// Node trusts only its bundled CA list. Antivirus HTTPS scanning and filtering
// networks re-sign traffic with a root that only Windows knows about, so on
// those PCs every Node request fails ("unable to verify the first
// certificate"): Microsoft sign-in refresh, mod downloads, the game files.
// Trust what Windows trusts, on top of the bundled list.
const tls = require('tls');
const fs = require('fs');
const { execFile, execFileSync } = require('child_process');

const PS_SCRIPT = [
  '$seen=@{}; $now=Get-Date;',
  "foreach($p in 'Cert:\\LocalMachine\\Root','Cert:\\CurrentUser\\Root','Cert:\\LocalMachine\\CA','Cert:\\CurrentUser\\CA'){",
  '  Get-ChildItem $p -EA SilentlyContinue | Where-Object { $_.NotAfter -gt $now -and -not $seen[$_.Thumbprint] } |',
  '  ForEach-Object { $seen[$_.Thumbprint]=1; [Convert]::ToBase64String($_.RawData) } }',
].join(' ');
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT];

const strip = (pem) => pem.replace(/-----[^-]+-----|\s+/g, '');
const bundled = new Set(tls.rootCertificates.map(strip));
let extra = [];

function parse(output) {
  return output.split(/\r?\n/).map((l) => l.trim())
    .filter((b64) => /^[A-Za-z0-9+/=]{100,}$/.test(b64) && !bundled.has(b64))
    .map((b64) => `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`);
}

let patched = false;
function patch() {
  if (patched) return;
  patched = true;
  const original = tls.createSecureContext;
  tls.createSecureContext = function createSecureContext(options, ...rest) {
    const ctx = original.call(this, options, ...rest);
    // An explicit ca list means the caller pinned its own roots.
    if (!options?.ca) {
      for (const pem of extra) {
        try { ctx.context.addCACert(pem); } catch { /* malformed or duplicate */ }
      }
    }
    return ctx;
  };
}

function use(pems) {
  if (!pems.length) return;
  extra = pems;
  patch();
}

// Cached copy loads instantly; the store is re-read in the background so a
// newly installed root is picked up on the next start at the latest.
function loadWindowsCerts(cacheFile) {
  if (process.platform !== 'win32') return;
  let cached = null;
  try { cached = fs.readFileSync(cacheFile, 'utf8'); } catch { /* first run */ }
  if (cached) {
    use(parse(cached));
    execFile('powershell.exe', PS_ARGS, { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, out) => {
      if (err || !out) return;
      use(parse(out));
      try { fs.writeFileSync(cacheFile, out); } catch { /* read-only profile */ }
    });
    return;
  }
  try {
    const out = execFileSync('powershell.exe', PS_ARGS, { windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 15000 });
    use(parse(out));
    try { fs.writeFileSync(cacheFile, out); } catch { /* read-only profile */ }
  } catch { /* stay on the bundled list */ }
}

module.exports = { loadWindowsCerts };
