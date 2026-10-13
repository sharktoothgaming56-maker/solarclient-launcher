// =====================================================================
// BEDROCK EDITION SUPPORT
//
// Bedrock ("Minecraft for Windows") is a UWP/GDK Store app, not a jar.
// It can't be launched with a Java command line, and there's no legal
// way to download or version-switch it outside the Microsoft Store —
// what a launcher CAN do is detect the install and start it through the
// registered `minecraft://` URI protocol, which is exactly how the
// official launcher's "Play" button works for Bedrock.
//
// Multi-version switching (à la BedrockLauncher/mc-w10-version-launcher)
// requires re-registering appx packages with developer mode + admin
// rights, and only one Bedrock instance can run at a time. We
// deliberately don't do that: it's invasive, breaks often, and needs
// elevation. We launch the installed version, which is honest and works.
// =====================================================================
const { shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const BEDROCK_PACKAGE = 'Microsoft.MinecraftUWP_8wekyb3d8bbwe';
const BEDROCK_PREVIEW_PACKAGE = 'Microsoft.MinecraftWindowsBeta_8wekyb3d8bbwe';

function bedrockDataDir(preview = false) {
  const local = process.env.LOCALAPPDATA;
  if (!local) return null;
  return path.join(local, 'Packages', preview ? BEDROCK_PREVIEW_PACKAGE : BEDROCK_PACKAGE);
}

// Presence of the package data folder is a reliable, cheap signal the
// game is installed for this user. We confirm with PowerShell when we can.
function quickDetect(preview = false) {
  const dir = bedrockDataDir(preview);
  return !!(dir && fs.existsSync(dir));
}

function psDetect(preview) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const name = preview ? 'Microsoft.MinecraftWindowsBeta' : 'Microsoft.MinecraftUWP';
    exec(
      `powershell -NoProfile -Command "$p = Get-AppxPackage -Name ${name} -ErrorAction SilentlyContinue; if ($p) { $p.Version }"`,
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const v = (stdout || '').trim();
        resolve(v || null);
      }
    );
  });
}

async function detectBedrock() {
  if (process.platform !== 'win32') {
    return {
      supported: false,
      installed: false,
      reason: 'Bedrock Edition for PC is Windows-only. On macOS and Linux there is no Bedrock client to launch.',
    };
  }

  const [release, preview] = await Promise.all([psDetect(false), psDetect(true)]);
  const releaseInstalled = !!release || quickDetect(false);
  const previewInstalled = !!preview || quickDetect(true);

  return {
    supported: true,
    installed: releaseInstalled || previewInstalled,
    release: { installed: releaseInstalled, version: release || null },
    preview: { installed: previewInstalled, version: preview || null },
    storeUrl: 'ms-windows-store://pdp/?productid=9NBLGGH2JHXJ',
    reason: (releaseInstalled || previewInstalled)
      ? null
      : 'Minecraft for Windows (Bedrock) isn\'t installed. Get it from the Microsoft Store, then it will show up here.',
  };
}

// Launch through the registered protocol handler — same mechanism the
// official launcher uses. `minecraft://` = release, `minecraft-preview://`
// = Preview builds.
async function launchBedrock({ preview = false } = {}) {
  if (process.platform !== 'win32') {
    throw new Error('Bedrock Edition can only be launched on Windows.');
  }
  const detected = await detectBedrock();
  const target = preview ? detected.preview : detected.release;
  if (!target?.installed) {
    throw new Error(preview
      ? 'Minecraft Preview isn\'t installed. Install it from the Microsoft Store first.'
      : 'Minecraft for Windows (Bedrock) isn\'t installed. Install it from the Microsoft Store first.');
  }
  const uri = preview ? 'minecraft-preview://' : 'minecraft://';
  const err = await shell.openExternal(uri).then(() => null).catch(e => e);
  if (err) throw new Error(`Windows refused to open ${uri} (${err.message}). Try launching Bedrock once from the Store app to register it.`);
  return { launched: true, preview, version: target.version };
}

function openBedrockStorePage() {
  return shell.openExternal('ms-windows-store://pdp/?productid=9NBLGGH2JHXJ');
}

module.exports = { detectBedrock, launchBedrock, openBedrockStorePage, bedrockDataDir };
