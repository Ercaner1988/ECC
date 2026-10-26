/**
 * Shared formatter resolution utilities with caching.
 *
 * Extracts project-root discovery, formatter detection, and binary
 * resolution into a single module so that post-edit-format.js and
 * quality-gate.js avoid duplicating work and filesystem lookups.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Caches (per-process, cleared on next hook invocation) ───────────
const projectRootCache = new Map();
const formatterCache = new Map();
const binCache = new Map();

// ── Config file lists (single source of truth) ─────────────────────

const BIOME_CONFIGS = ['biome.json', 'biome.jsonc'];

const PRETTIER_CONFIGS = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  '.prettierrc.toml',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  // The rest of the names Prettier's config searcher looks for
  // (src/config/prettier-config/config-searcher.js).
  '.prettierrc.json5',
  '.prettierrc.ts',
  '.prettierrc.mts',
  '.prettierrc.cts',
  'prettier.config.ts',
  'prettier.config.mts',
  'prettier.config.cts'
];

const PROJECT_ROOT_MARKERS = ['package.json', ...BIOME_CONFIGS, ...PRETTIER_CONFIGS];

// ── Windows .cmd shim mapping ───────────────────────────────────────
// bunx is deliberately absent: Bun installs bunx.exe only (no bunx.cmd), and a
// real executable needs no shell shim.
const WIN_CMD_SHIMS = { npx: 'npx.cmd', pnpm: 'pnpm.cmd', yarn: 'yarn.cmd' };

// ── Formatter → package name mapping ────────────────────────────────
const FORMATTER_PACKAGES = {
  biome: { binName: 'biome', pkgName: '@biomejs/biome' },
  prettier: { binName: 'prettier', pkgName: 'prettier' }
};

// ── Public helpers ──────────────────────────────────────────────────

/**
 * Walk up from `startDir` until a directory containing a known project
 * root marker (package.json or formatter config) is found.
 * Returns `startDir` as fallback when no marker exists above it.
 *
 * @param {string} startDir - Absolute directory path to start from
 * @returns {string} Absolute path to the project root
 */
function findProjectRoot(startDir) {
  if (projectRootCache.has(startDir)) return projectRootCache.get(startDir);

  const homeDir = os.homedir();
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    // Stop before checking the home directory to avoid treating global
    // dotfiles (e.g. ~/.prettierrc) as a project root marker.
    if (dir === homeDir) break;
    for (const marker of PROJECT_ROOT_MARKERS) {
      if (fs.existsSync(path.join(dir, marker))) {
        projectRootCache.set(startDir, dir);
        return dir;
      }
    }
    dir = path.dirname(dir);
  }

  projectRootCache.set(startDir, startDir);
  return startDir;
}

/**
 * Detect the formatter configured in the project.
 * Biome takes priority over Prettier.
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @returns {'biome' | 'prettier' | null}
 */
function detectFormatter(projectRoot) {
  if (formatterCache.has(projectRoot)) return formatterCache.get(projectRoot);

  for (const cfg of BIOME_CONFIGS) {
    if (fs.existsSync(path.join(projectRoot, cfg))) {
      formatterCache.set(projectRoot, 'biome');
      return 'biome';
    }
  }

  // Check package.json "prettier" key before config files
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if ('prettier' in pkg) {
        formatterCache.set(projectRoot, 'prettier');
        return 'prettier';
      }
    }
  } catch {
    // Malformed package.json — continue to file-based detection
  }

  for (const cfg of PRETTIER_CONFIGS) {
    if (fs.existsSync(path.join(projectRoot, cfg))) {
      formatterCache.set(projectRoot, 'prettier');
      return 'prettier';
    }
  }

  formatterCache.set(projectRoot, null);
  return null;
}

/**
 * Runner used when no package manager could be resolved: Bun's own runner when
 * this process is Bun (so Bun is certainly installed), otherwise npx.
 */
function defaultExecCmd() {
  return process.versions && process.versions.bun ? 'bunx' : 'npx';
}

/**
 * Locate a locally installed binary in <dir>/node_modules/.bin. On Windows
 * npm/pnpm/yarn create <name>.cmd shims while Bun creates <name>.exe.
 *
 * @param {string} dir - Directory containing node_modules
 * @param {string} binName - Binary name (e.g. 'tsc', 'prettier')
 * @returns {string | null} Absolute path of the binary, or null
 */
function findLocalBin(dir, binName) {
  const binDir = path.join(dir, 'node_modules', '.bin');
  const names = process.platform === 'win32' ? [`${binName}.cmd`, `${binName}.exe`] : [binName];
  for (const name of names) {
    const candidate = path.join(binDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve the runner binary and prefix args for the configured package
 * manager (respects CLAUDE_PACKAGE_MANAGER env and project config).
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @returns {{ bin: string, prefix: string[] }}
 */
function getRunnerFromPackageManager(projectRoot) {
  const isWin = process.platform === 'win32';
  const { getPackageManager } = require('./package-manager');
  const pm = getPackageManager({ projectDir: projectRoot });
  const execCmd = pm?.config?.execCmd || defaultExecCmd();
  const [rawBin = defaultExecCmd(), ...prefix] = execCmd.split(/\s+/).filter(Boolean);
  const bin = isWin ? WIN_CMD_SHIMS[rawBin] || rawBin : rawBin;
  return { bin, prefix };
}

/**
 * Resolve the formatter binary, preferring the local node_modules/.bin
 * installation over the package manager exec command to avoid
 * package-resolution overhead.
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @param {'biome' | 'prettier'} formatter - Detected formatter name
 * @returns {{ bin: string, prefix: string[] } | null}
 *   `bin`    – executable path (absolute local path or runner binary)
 *   `prefix` – extra args to prepend (e.g. ['@biomejs/biome'] when using npx)
 */
function resolveFormatterBin(projectRoot, formatter) {
  const cacheKey = `${projectRoot}:${formatter}`;
  if (binCache.has(cacheKey)) return binCache.get(cacheKey);

  const pkg = FORMATTER_PACKAGES[formatter];
  if (!pkg) {
    binCache.set(cacheKey, null);
    return null;
  }

  const localBin = findLocalBin(projectRoot, pkg.binName);

  if (localBin) {
    const result = { bin: localBin, prefix: [] };
    binCache.set(cacheKey, result);
    return result;
  }

  const runner = getRunnerFromPackageManager(projectRoot);
  const result = { bin: runner.bin, prefix: [...runner.prefix, pkg.pkgName] };
  binCache.set(cacheKey, result);
  return result;
}

/**
 * Clear all caches. Useful for testing.
 */
function clearCaches() {
  projectRootCache.clear();
  formatterCache.clear();
  binCache.clear();
}

module.exports = {
  findProjectRoot,
  detectFormatter,
  resolveFormatterBin,
  getRunnerFromPackageManager,
  defaultExecCmd,
  findLocalBin,
  clearCaches
};
