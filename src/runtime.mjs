// Where the installed hooks run from. `install` writes two paths into each agent's
// configuration: a Node.js binary and the open-prompts script. Both must outlive the place
// install ran from: `pnpm exec` or `npx` in a worktree runs a copy that is deleted with
// the worktree or the cache, and the Node of a version manager (nvm, fnm, Volta...) goes
// away when that version is removed. So `install` copies the files the hooks need to a
// stable directory, and prefers a Node.js installed for the whole system.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** What the hooks and the OpenCode plugin need, relative to the package root. */
const RUNTIME_ENTRIES = ['bin', 'src', 'package.json', 'LICENSE'];
/** Written in the copy: what it holds, so `install` can skip copying it again. */
const MANIFEST = '.open-prompts-runtime.json';

/**
 * The directory the runtime is copied to: OPEN_PROMPTS_DATA_DIR, or `open-prompts` in
 * XDG_DATA_HOME (~/.local/share by default). On Windows, `open-prompts\runtime` in
 * LOCALAPPDATA, next to the state directory.
 */
export function runtimeDir(env = process.env) {
  if (env.OPEN_PROMPTS_DATA_DIR) return path.resolve(env.OPEN_PROMPTS_DATA_DIR);
  if (process.platform === 'win32' && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, 'open-prompts', 'runtime');
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'open-prompts');
}

/** The script the hooks run, inside a runtime directory. */
export const runtimeScript = (dir) => path.join(dir, 'bin', 'open-prompts');

/** The files under `root` that make up the runtime, as paths relative to `root`, sorted. */
function runtimeFiles(root) {
  const files = [];
  const walk = (relative) => {
    const full = path.join(root, relative);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(full).sort()) if (!name.startsWith('.')) walk(path.join(relative, name));
    } else if (stat.isFile()) files.push(relative);
  };
  for (const entry of RUNTIME_ENTRIES) if (fs.existsSync(path.join(root, entry))) walk(entry);
  return files;
}

/** A hash of the runtime's files and their content, to tell whether a copy is up to date. */
function contentHash(root, files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) hash.update(`${file.split(path.sep).join('/')}\0`).update(fs.readFileSync(path.join(root, file))).update('\0');
  return hash.digest('hex');
}

const readManifest = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
  } catch {
    return null;
  }
};

/** Whether `dir` is a directory with nothing in it. */
function isEmptyDir(dir) {
  try {
    return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/**
 * Copies the runtime from the package at `sourceRoot` to the runtime directory, unless the
 * copy there already holds the same files. The copy is made next to its destination, then
 * renamed into place, so a hook never runs half a copy.
 * Returns { dir, scriptPath, copied }.
 */
export function installRuntime(sourceRoot, env = process.env) {
  const dir = runtimeDir(env);
  const source = path.resolve(sourceRoot);
  // Run from the copy itself, as with "~/.local/share/open-prompts/bin/open-prompts install".
  if (fs.existsSync(dir) && fs.realpathSync(dir) === fs.realpathSync(source)) return { dir, scriptPath: runtimeScript(dir), copied: false };
  const files = runtimeFiles(source);
  const hash = contentHash(source, files);
  if (readManifest(dir)?.hash === hash) return { dir, scriptPath: runtimeScript(dir), copied: false };

  // Only a copy made by install, or an empty directory, is replaced: OPEN_PROMPTS_DATA_DIR
  // may point at a directory that holds other files.
  if (fs.existsSync(dir) && !readManifest(dir) && !isEmptyDir(dir)) {
    throw new Error(`${dir} exists and is not a copy of open-prompts made by install, so it is left alone. Choose another directory with OPEN_PROMPTS_DATA_DIR, or empty this one.`);
  }
  const parent = path.dirname(dir);
  fs.mkdirSync(parent, { recursive: true });
  const temp = path.join(parent, `.${path.basename(dir)}-${process.pid}-${crypto.randomUUID()}.tmp`);
  try {
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(temp, file)), { recursive: true });
      fs.copyFileSync(path.join(source, file), path.join(temp, file));
    }
    fs.chmodSync(runtimeScript(temp), 0o755);
    const version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version;
    fs.writeFileSync(path.join(temp, MANIFEST), `${JSON.stringify({ version, hash, source, copied: new Date().toISOString() }, null, 2)}\n`);
    // A directory cannot be renamed over another one, so the old copy moves aside first.
    const old = fs.existsSync(dir) ? `${temp}.old` : null;
    if (old) fs.renameSync(dir, old);
    try {
      fs.renameSync(temp, dir);
    } catch (error) {
      if (old) fs.renameSync(old, dir);
      throw error;
    }
    if (old) fs.rmSync(old, { recursive: true, force: true });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  return { dir, scriptPath: runtimeScript(dir), copied: true };
}

/** What the runtime copy holds ({ version, hash, source, copied }), or null when there is none. */
export const runtimeInfo = (env = process.env) => readManifest(runtimeDir(env));

/** Removes the runtime copy, if it is one (it has the manifest). Returns whether it did. */
export function removeRuntime(env = process.env) {
  const dir = runtimeDir(env);
  if (!readManifest(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

// ---------------------------------------------------------------------------
// Which Node.js the hooks run with

/** Directories of Node.js version managers, whose versions come and go. */
const VERSION_MANAGERS = [
  ['nvm', /[\\/]\.?nvm[\\/]/i],
  ['fnm', /[\\/](?:\.?fnm|fnm_multishells)[\\/]/i],
  ['Volta', /[\\/]\.?volta[\\/]/i],
  ['asdf', /[\\/]\.asdf[\\/]/],
  ['mise', /[\\/](?:\.?mise|rtx)[\\/]installs[\\/]/],
  ['nodenv', /[\\/]\.nodenv[\\/]/],
  ['n', /[\\/]n[\\/]versions[\\/]node[\\/]/],
  ['nvs', /[\\/]\.?nvs[\\/]/i],
  ['nodebrew', /[\\/]\.nodebrew[\\/]/],
  ['proto', /[\\/]\.proto[\\/]tools[\\/]/],
  ['pnpm', /[\\/]pnpm[\\/](?:nodejs|node-versions)[\\/]/i],
];

/**
 * Why the Node.js at `file` may not stay there, in a few words such as "managed by nvm",
 * or null. Besides version managers: Homebrew's versioned directories (Cellar, replaced on
 * each upgrade, while /opt/homebrew/bin/node stays) and node_modules.
 */
export function unstableNode(file) {
  const manager = VERSION_MANAGERS.find(([, pattern]) => pattern.test(file));
  if (manager) return `managed by ${manager[0]}`;
  if (/[\\/]Cellar[\\/]node(?:@\d+)?[\\/]/.test(file)) return 'in a versioned Homebrew directory, which upgrades replace';
  if (/[\\/]node_modules[\\/]/.test(file)) return 'in a node_modules directory';
  return null;
}

/** Where a Node.js installed for the whole system usually is, first found first used. */
export function systemNodeCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    return [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean).map((dir) => path.join(dir, 'nodejs', 'node.exe'));
  }
  return ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node', '/home/linuxbrew/.linuxbrew/bin/node', '/snap/bin/node'];
}

/** The major version of the Node.js at `file`, or null when it does not run. */
export function nodeMajor(file) {
  try {
    const result = spawnSync(file, ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const match = /^v(\d+)\./.exec(result.stdout ?? '');
    return result.status === 0 && match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Whether the Node.js at `file` loads node:sqlite without a flag (22.13 or later), which the
 * hooks need to read T3 Code's database.
 */
export function nodeHasSqlite(file) {
  try {
    const script = "import('node:sqlite').then(() => process.exit(0), () => process.exit(1))";
    const result = spawnSync(file, ['--no-warnings', '-e', script], { timeout: 10_000, stdio: 'ignore', windowsHide: true });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** The oldest Node.js the hooks run on (package.json "engines"). */
export const MIN_NODE_MAJOR = 18;

/** A warning when the system-wide Node.js picked cannot read T3 Code's database, but `execPath` can. */
function sqliteWarning(execPath, candidate, sqliteOf) {
  if (!sqliteOf(execPath) || sqliteOf(candidate)) return null;
  return (
    `The hooks run Node.js from ${candidate}, which cannot read T3 Code's database (node:sqlite needs Node.js 22.13 or later), while ${execPath} can. ` +
    'Under T3 Code, the hooks will then recognize agent messages by their wording only. To avoid it, update that Node.js, ' +
    'or give one that can with "open-prompts install --node <path>".'
  );
}

/**
 * Picks the Node.js for the hooks. `execPath` (the one running install) when it is stable.
 * When a version manager owns it, the first system-wide Node.js that is recent enough and
 * is not itself a link into a version manager, with a warning when it cannot read T3 Code's
 * database and `execPath` can. Otherwise `execPath`, with a warning.
 * Returns { nodePath, warning }.
 */
export function pickNode({ execPath = process.execPath, candidates = systemNodeCandidates(), majorOf = nodeMajor, sqliteOf = nodeHasSqlite } = {}) {
  const why = unstableNode(execPath);
  if (!why) return { nodePath: execPath, warning: null };
  const skipped = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    let real;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    if (VERSION_MANAGERS.some(([, pattern]) => pattern.test(real))) {
      skipped.push(`${candidate} (a link into a version manager)`);
      continue;
    }
    const major = majorOf(candidate);
    if (major !== null && major >= MIN_NODE_MAJOR) return { nodePath: candidate, warning: sqliteWarning(execPath, candidate, sqliteOf) };
    skipped.push(`${candidate} (${major === null ? 'does not run' : `Node.js ${major}, too old`})`);
  }
  const found = skipped.length > 0 ? ` The system-wide Node.js found cannot be used: ${skipped.join(', ')}.` : ' No system-wide Node.js was found.';
  return {
    nodePath: execPath,
    warning:
      `The hooks run Node.js from ${execPath}, ${why}: they stop working once that version is removed.${found} ` +
      `To fix it, install Node.js ${MIN_NODE_MAJOR} or later for the whole system (for example with Homebrew or your package manager) and run "open-prompts install" again, ` +
      'or give a Node.js that stays in place with "open-prompts install --node <path>".',
  };
}
