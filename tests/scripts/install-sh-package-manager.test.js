/**
 * install.sh dependency bootstrap: prefers Bun when present, else npm.
 *
 * Hermetic: functions injected through BASH_ENV stand in for bun/npm, and the
 * final `exec node` runs a stub install-apply.js from a temp copy of the repo.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..', '..');

function test(name, fn) {
  try {
    fn();
    console.log('  \u2713 ' + name);
    return true;
  } catch (error) {
    console.log('  \u2717 ' + name);
    console.log('    Error: ' + error.message);
    return false;
  }
}

function toBashPath(filePath) {
  return process.platform === 'win32'
    ? '/' + filePath[0].toLowerCase() + filePath.slice(2).replace(/\\/g, '/')
    : filePath;
}

function resolveBash() {
  if (process.env.BASH_PATH) return process.env.BASH_PATH;
  if (process.platform === 'win32' && fs.existsSync('C:\\Program Files\\Git\\bin\\bash.exe')) {
    return 'C:\\Program Files\\Git\\bin\\bash.exe';
  }
  return fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
}

function runInstallSh({ bunAvailable }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-install-sh-'));
  try {
    const copy = path.join(tempDir, 'install.sh');
    fs.copyFileSync(path.join(repoRoot, 'install.sh'), copy);
    fs.mkdirSync(path.join(tempDir, 'scripts'));
    fs.writeFileSync(path.join(tempDir, 'scripts', 'install-apply.js'), '// stub\n');
    const calls = path.join(tempDir, 'calls.txt');
    const callsBash = toBashPath(calls);
    const bashEnv = path.join(tempDir, 'bash-env');
    const lines = [
      `npm() { printf 'npm %s\\n' "$*" >> "${callsBash}"; }`,
    ];
    if (bunAvailable) {
      lines.push(`bun() { printf 'bun %s\\n' "$*" >> "${callsBash}"; }`);
    } else {
      lines.push('command() { if [ "$1" = "-v" ] && [ "$2" = "bun" ]; then return 1; fi; builtin command "$@"; }');
    }
    fs.writeFileSync(bashEnv, lines.join('\n') + '\n');
    const result = spawnSync(resolveBash(), [copy], {
      cwd: tempDir,
      env: { ...process.env, BASH_ENV: toBashPath(bashEnv), MSYS_NO_PATHCONV: '1' },
      encoding: 'utf8',
    });
    const recorded = fs.existsSync(calls)
      ? fs.readFileSync(calls, 'utf8').trim().split(/\r?\n/)
      : [];
    return { result, recorded };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

let passed = 0;
let failed = 0;

if (test('install.sh installs dependencies with bun --ignore-scripts when bun is available', () => {
  const { result, recorded } = runInstallSh({ bunAvailable: true });
  assert.strictEqual(result.status, 0, result.stdout + '\n' + result.stderr);
  assert.strictEqual(recorded.length, 1, JSON.stringify(recorded));
  assert.match(recorded[0], /^bun install .*--ignore-scripts/);
})) passed++; else failed++;

if (test('install.sh keeps npm install --ignore-scripts when bun is not available', () => {
  const { result, recorded } = runInstallSh({ bunAvailable: false });
  assert.strictEqual(result.status, 0, result.stdout + '\n' + result.stderr);
  assert.strictEqual(recorded.length, 1, JSON.stringify(recorded));
  assert.match(recorded[0], /^npm install .*--ignore-scripts/);
})) passed++; else failed++;

console.log('\nPassed: ' + passed);
console.log('Failed: ' + failed);
process.exit(failed > 0 ? 1 : 0);
