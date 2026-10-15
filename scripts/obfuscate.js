'use strict';
/**
 * SolarClient source protection.
 *
 * Runs the launcher's own JavaScript through javascript-obfuscator so the
 * copy that ships inside app.asar is scrambled, string-encrypted and
 * self-defending instead of readable source. This is only applied to the
 * packaged build (see dist-protected.js); the working tree stays readable.
 *
 * Two settings are deliberately OFF because turning them on would break the
 * launcher:
 *   renameGlobals      - top-level names are shared across the renderer's
 *                        script files and used as require() exports, so they
 *                        must keep their names.
 *   transformObjectKeys - IPC channel maps and the window.nebula bridge rely
 *                        on exact key names.
 */
const fs = require('fs');
const JsObf = require('javascript-obfuscator');

const BASE = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.6,
  deadCodeInjection: false,
  numbersToExpressions: true,
  simplify: true,
  stringArray: true,
  stringArrayEncoding: ['rc4'],
  stringArrayThreshold: 1,
  splitStrings: true,
  splitStringsChunkLength: 8,
  transformObjectKeys: false,
  renameGlobals: false,
  identifierNamesGenerator: 'hexadecimal',
  selfDefending: true,
  disableConsoleOutput: false,
  unicodeEscapeSequence: false,
  log: false,
};

// The renderer runs per-frame (pointer, resize, rAF) handlers; control-flow
// flattening, rc4 string decoding, split strings and self-defending made the
// packaged UI several times heavier than the readable dev build. Keep names
// mangled and strings tabled, drop the transforms that cost CPU at runtime.
const BROWSER = {
  ...BASE,
  controlFlowFlattening: false,
  numbersToExpressions: false,
  stringArrayEncoding: [],
  stringArrayThreshold: 0.75,
  splitStrings: false,
  selfDefending: false,
};

function obfuscateCode(code, target = 'node') {
  return JsObf.obfuscate(code, { ...(target === 'browser' ? BROWSER : BASE), target }).getObfuscatedCode();
}

function obfuscateFile(file, target = 'node') {
  fs.writeFileSync(file, obfuscateCode(fs.readFileSync(file, 'utf8'), target));
}

module.exports = { obfuscateFile, obfuscateCode };
