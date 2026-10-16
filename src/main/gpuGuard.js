// Graphics-preserving GPU check. It reports what is driving the game and
// what is in the way. It does not rewrite video settings, shaders, or leaves.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function execOut(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 8000, encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

function num(value) {
  const n = Number(String(value || '').trim());
  return Number.isFinite(n) ? n : null;
}

async function windowsControllers() {
  if (process.platform !== 'win32') return [];
  const ps = "Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,PNPDeviceID | ConvertTo-Json -Compress";
  const out = await execOut('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  if (!out.trim()) return [];
  try {
    const parsed = JSON.parse(out);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter((g) => g && g.Name).map((g) => {
      const name = String(g.Name);
      const discrete = /nvidia|geforce|quadro|radeon|rx\s?\d/i.test(name) && !/intel/i.test(name);
      const integrated = /intel|uhd|iris xe|radeon\(tm\) graphics|basic display/i.test(name);
      return {
        name,
        driver: g.DriverVersion ? String(g.DriverVersion) : '',
        discrete: discrete && !integrated,
        integrated: integrated || !discrete,
      };
    });
  } catch {
    return [];
  }
}

async function nvidiaCards() {
  const out = await execOut('nvidia-smi', [
    '--query-gpu=index,name,driver_version,utilization.gpu,temperature.gpu,power.draw,power.limit,memory.used,memory.total,pcie.link.gen.current,pcie.link.gen.max,pcie.link.width.current,pcie.link.width.max',
    '--format=csv,noheader,nounits',
  ]);
  if (!out.trim()) return [];
  return out.trim().split(/\r?\n/).map((line) => {
    const p = line.split(',').map((s) => s.trim());
    const [index, name, driver, util, temp, power, limit, used, total, gen, genMax, width, widthMax] = p;
    return {
      index, name, driver,
      util: num(util), temp: num(temp), power: num(power), limit: num(limit),
      used: num(used), total: num(total),
      gen: num(gen), genMax: num(genMax), width: num(width), widthMax: num(widthMax),
    };
  }).filter((g) => g.name);
}

function driverWarning(driver) {
  const major = num(String(driver || '').split('.')[0]);
  // nvidia-smi reports the branch (566, 572, 576). A 5070 wants a recent branch.
  if (major != null && major > 0 && major < 550) {
    return `NVIDIA driver ${driver} looks old for this card. A current Game Ready driver is safer.`;
  }
  return null;
}

function vramLine(card) {
  if (card.used == null || card.total == null || card.total <= 0) return { text: 'VRAM: not reported', pressure: false };
  const pct = Math.round((card.used / card.total) * 100);
  const pressure = pct >= 90;
  return {
    text: `VRAM ${card.used} / ${card.total} MiB (${pct}%)`,
    pressure,
  };
}

function pcieLine(card) {
  if (card.gen == null || card.width == null) return null;
  const slowGen = card.genMax != null && card.gen < card.genMax;
  const slowWidth = card.widthMax != null && card.width < card.widthMax;
  const link = `PCIe Gen${card.gen} x${card.width}` + (card.genMax ? ` (card max Gen${card.genMax} x${card.widthMax})` : '');
  if (slowGen || slowWidth) return `${link} — the link is narrower than the card, which caps throughput.`;
  return link;
}

const RENDERERS = [
  ['sodium', /^sodium-.*\.jar$/i],
  ['embeddium', /^embeddium-.*\.jar$/i],
  ['vulkanmod', /^vulkanmod-.*\.jar$/i],
  ['optifine', /optifine/i],
  ['iris', /^iris-.*\.jar$/i],
  ['oculus', /^oculus-.*\.jar$/i],
];

function installedRenderers(instanceDir) {
  let names = [];
  try { names = fs.readdirSync(path.join(instanceDir, 'mods')); } catch { return []; }
  const jars = names.filter((n) => /\.jar$/i.test(n) && !/\.disabled$/i.test(n));
  return RENDERERS.filter(([, re]) => jars.some((n) => re.test(n))).map(([id]) => id);
}

function duplicateNotes(ids) {
  const notes = [];
  if (ids.includes('sodium') && ids.includes('embeddium')) notes.push('Sodium and Embeddium both replace the renderer. One of them has to come out or they fight.');
  if (ids.includes('sodium') && ids.includes('vulkanmod')) notes.push('Sodium and VulkanMod are two backends. Graphics-preserving mode will not swap them.');
  if (ids.includes('sodium') && ids.includes('optifine')) notes.push('Sodium and OptiFine are incompatible.');
  if (ids.includes('iris') && ids.includes('oculus')) notes.push('Iris and Oculus both own shaders. Keep one.');
  return notes;
}

function shaderNote(instanceDir, ids) {
  let text = '';
  try { text = fs.readFileSync(path.join(instanceDir, 'config', 'iris.properties'), 'utf8'); } catch { return null; }
  const on = /^\s*enableShaders\s*=\s*true\s*$/im.test(text);
  const pack = (/^\s*shaderPack\s*=\s*(.+)\s*$/im.exec(text) || [])[1] || '';
  if (on && !ids.includes('iris') && !ids.includes('oculus')) {
    return `Shader pack ${pack || '(selected)'} is on, but no shader mod is installed.`;
  }
  if (on && (ids.includes('iris') || ids.includes('oculus'))) {
    return `Shader pipeline is on (${pack || 'a pack'}). That is compatible with the installed shader mod.`;
  }
  if (!on && (ids.includes('iris') || ids.includes('oculus'))) {
    return 'Shaders are off. The shader mod stays installed so the picture does not change.';
  }
  return null;
}

function readGl(logText) {
  const vendor = (/OpenGL Vendor:\s*(.+)/i.exec(logText) || [])[1];
  const renderer = (/OpenGL Renderer:\s*(.+)/i.exec(logText) || [])[1];
  const version = (/OpenGL Version:\s*(\d+(?:\.\d+)*)/i.exec(logText) || [])[1];
  const software = !!(renderer && /llvmpipe|softpipe|microsoft basic render|gdi generic|swiftshader/i.test(renderer));
  const major = version ? parseInt(version, 10) : null;
  return {
    vendor: vendor ? vendor.trim() : '',
    renderer: renderer ? renderer.trim() : '',
    version: version || '',
    software,
    unsupported: major != null && major < 3,
  };
}

function profilePath(userData) {
  return path.join(userData, 'renderer-profiles.json');
}

// null = nvidia-smi did not answer. true = this pid is on the NVIDIA card.
async function minecraftOnNvidia(pid) {
  if (!pid) return null;
  const out = await execOut('nvidia-smi', []);
  if (!out.trim()) return null;
  const id = String(pid);
  return out.split(/\r?\n/).some((line) => {
    const parts = line.trim().split(/\s+/);
    return parts.includes(id) && /java/i.test(line);
  });
}

function rememberProfile(userData, key, patch) {
  if (!userData || !key) return;
  const file = profilePath(userData);
  let all = {};
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { all = {}; }
  all[key] = { ...(all[key] || {}), ...patch, mode: 'graphics-preserving', at: new Date().toISOString() };
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all, null, 2));
  } catch { /* profile is advisory */ }
}

// Runs before Java starts. Video options are not touched.
async function inspectBeforeLaunch({ instanceDir, userData }) {
  const lines = ['[SolarClient] Graphics-preserving check. Clouds, leaves, water, lighting, entities, particles, mipmaps, and render distance stay as this instance saved them.'];
  const controllers = await windowsControllers();
  const discrete = controllers.filter((g) => g.discrete);
  const integrated = controllers.filter((g) => g.integrated);
  if (discrete.length) lines.push(`[SolarClient] Dedicated GPU: ${discrete.map((g) => g.name).join(', ')}`);
  if (integrated.length) lines.push(`[SolarClient] Integrated GPU: ${integrated.map((g) => g.name).join(', ')}`);
  if (!controllers.length) lines.push('[SolarClient] Could not list display adapters.');

  const cards = await nvidiaCards();
  for (const card of cards) {
    lines.push(`[SolarClient] NVIDIA ${card.name} — driver ${card.driver || 'unknown'}`);
    const old = driverWarning(card.driver);
    if (old) lines.push(`[SolarClient] ${old}`);
    const bits = [];
    if (card.util != null) bits.push(`util ${card.util}%`);
    if (card.temp != null) bits.push(`${card.temp}°C`);
    if (card.power != null && card.limit != null) bits.push(`power ${card.power} / ${card.limit} W`);
    else if (card.limit != null) bits.push(`power limit ${card.limit} W`);
    if (bits.length) lines.push(`[SolarClient] GPU ${bits.join(', ')}`);
    const vram = vramLine(card);
    lines.push(`[SolarClient] ${vram.text}`);
    if (vram.pressure) lines.push('[SolarClient] VRAM is nearly full. That will pull the frame rate down.');
    const pcie = pcieLine(card);
    if (pcie) lines.push(`[SolarClient] ${pcie}`);
    rememberProfile(userData, card.name, { driver: card.driver, backend: 'sodium-opengl' });
  }

  const ids = installedRenderers(instanceDir);
  if (ids.length) lines.push(`[SolarClient] Renderer mods: ${ids.join(', ')}`);
  for (const note of duplicateNotes(ids)) lines.push(`[SolarClient] ${note}`);
  const shader = shaderNote(instanceDir, ids);
  if (shader) lines.push(`[SolarClient] ${shader}`);
  if (ids.includes('vulkanmod') && ids.includes('sodium')) {
    lines.push('[SolarClient] Backend swap skipped. Changing Sodium for VulkanMod would change the picture.');
  } else if (ids.includes('sodium')) {
    lines.push('[SolarClient] Staying on Sodium’s OpenGL backend. No second backend is loaded.');
  }
  return lines;
}

// Runs once the game has printed its GL line.
function inspectGameLog(logText, userData) {
  const lines = [];
  if (!logText) return lines;
  const gl = readGl(logText);
  if (gl.renderer) {
    lines.push(`[SolarClient] Minecraft OpenGL renderer: ${gl.renderer}`);
    if (gl.vendor) lines.push(`[SolarClient] OpenGL vendor: ${gl.vendor}`);
    if (gl.version) lines.push(`[SolarClient] OpenGL version: ${gl.version}`);
    rememberProfile(userData, gl.renderer, { gl: gl.version, vendor: gl.vendor });
  }
  if (gl.software) lines.push('[SolarClient] The game is on a software renderer. It is not using the discrete GPU.');
  if (gl.unsupported) lines.push(`[SolarClient] OpenGL ${gl.version} is too old for this game.`);
  const sodium = (/Sodium:\s*\[([^\]]+)\]/i.exec(logText) || [])[1];
  if (/Loaded configuration file for Sodium/i.test(logText) || sodium) {
    lines.push(`[SolarClient] Sodium initialized${sodium ? `: ${sodium.trim()}` : ''}.`);
  } else if (/OpenGL Renderer:/i.test(logText)) {
    lines.push('[SolarClient] Sodium did not report in. The vanilla renderer is in use.');
  }
  return lines;
}

module.exports = { inspectBeforeLaunch, inspectGameLog, minecraftOnNvidia };
