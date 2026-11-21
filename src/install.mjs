// Installing the hooks into each agent's user configuration.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claudeConfigDir } from './agents/claude-code.mjs';
import { codexHome } from './agents/codex.mjs';
import { copilotHome } from './agents/copilot.mjs';

export const AGENTS = ['claude-code', 'codex', 'cursor', 'gemini-cli', 'copilot', 'opencode', 'mistral-vibe'];

export const AGENT_NAMES = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  'gemini-cli': 'Gemini CLI',
  copilot: 'GitHub Copilot CLI',
  opencode: 'OpenCode',
  'mistral-vibe': 'Mistral Vibe',
};

const home = () => os.homedir();
const claudeDir = (env) => claudeConfigDir(env);
const codexDir = (env) => codexHome(env);
const vibeDir = (env) => env.VIBE_HOME || path.join(home(), '.vibe');
const opencodeDir = (env) => env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(home(), '.config'), 'opencode');

/** The file each agent's hooks go to. */
export function configPath(agent, env = process.env) {
  switch (agent) {
    case 'claude-code':
      return path.join(claudeDir(env), 'settings.json');
    case 'codex':
      return path.join(codexDir(env), 'hooks.json');
    case 'cursor':
      return path.join(home(), '.cursor', 'hooks.json');
    case 'gemini-cli':
      return path.join(home(), '.gemini', 'settings.json');
    case 'copilot':
      return path.join(copilotHome(env), 'hooks', 'open-prompts.json');
    case 'opencode':
      return path.join(opencodeDir(env), 'plugins', 'open-prompts.js');
    case 'mistral-vibe':
      return path.join(vibeDir(env), 'hooks.toml');
    default:
      throw new Error(`unknown agent "${agent}"`);
  }
}

/** Agents whose configuration directory exists on this machine. */
export function detectInstalledAgents(env = process.env) {
  const dirs = {
    'claude-code': [claudeDir(env)],
    codex: [codexDir(env)],
    cursor: [path.join(home(), '.cursor')],
    'gemini-cli': [path.join(home(), '.gemini')],
    copilot: [copilotHome(env)],
    opencode: [opencodeDir(env), path.join(home(), '.opencode')],
    'mistral-vibe': [vibeDir(env)],
  };
  return AGENTS.filter((agent) => dirs[agent].some((dir) => fs.existsSync(dir)));
}

// ---------------------------------------------------------------------------
// Commands and how to recognize ours

const quote = (value) => (process.platform === 'win32' ? `"${value}"` : `'${value.replace(/'/g, `'\\''`)}'`);
const shellCommand = ({ nodePath, scriptPath }, agent) => `${quote(nodePath)} ${quote(scriptPath)} hook --agent ${agent}`;
// Any path ending in bin/open-prompts: the runtime copy, and the global or local installs
// earlier versions pointed to, so that a new install replaces their entries.
const OUR_COMMAND = /[\\/]bin[\\/]open-prompts['"]?\s+hook\b/;
const isOurCommand = (value) => typeof value === 'string' && OUR_COMMAND.test(value);

/**
 * Splits a command written by shellCommand back into its words: single quotes (with the
 * `'\\''` escape), double quotes and backslashes are handled as a POSIX shell would.
 */
export function splitCommand(command) {
  const words = [];
  let word = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "'" || char === '"') {
      const end = command.indexOf(char, i + 1);
      if (end < 0) return words;
      word = (word ?? '') + command.slice(i + 1, end);
      i = end;
    } else if (char === '\\' && process.platform !== 'win32' && i + 1 < command.length) {
      word = (word ?? '') + command[++i];
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else word = (word ?? '') + char;
  }
  if (word !== null) words.push(word);
  return words;
}

/** The Node.js and script of one of our shell commands. */
const commandPaths = (command) => {
  const [nodePath, scriptPath] = splitCommand(command);
  return { nodePath, scriptPath };
};

// Claude Code entries run `<node> <...>/bin/open-prompts hook` in exec form.
const isOurClaudeHook = (hook) =>
  hook?.type === 'command' &&
  Array.isArray(hook.args) &&
  hook.args.at(-1) === 'hook' &&
  hook.args.some((arg) => /[\\/]bin[\\/]open-prompts$/.test(String(arg)));

// ---------------------------------------------------------------------------
// JSON files

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Could not parse ${file}: ${error.message}. Fix the file, then run the command again.`);
  }
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = `${file}.open-prompts.bak`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
}

const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

/**
 * Removes our hooks from a `{ hooks: { Event: [group...] } }` map, where each group has a
 * `hooks` array (Claude Code, Codex and Gemini CLI). Drops groups and events left empty.
 */
function withoutNested(config, isOurs) {
  const hooks = { ...(config.hooks ?? {}) };
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !isOurs(hook)) }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  const next = { ...config, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

/** Cursor's format: `{ version, hooks: { event: [entry...] } }` with no groups. */
function withoutFlat(config, isOurs) {
  const hooks = { ...(config.hooks ?? {}) };
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => !isOurs(entry));
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  return { ...config, hooks };
}

const hasNested = (config, isOurs) =>
  Object.values(config.hooks ?? {}).some((groups) => Array.isArray(groups) && groups.some((group) => (group.hooks ?? []).some(isOurs)));

// ---------------------------------------------------------------------------
// Per-agent install, uninstall and status

const TARGETS = {
  'claude-code': {
    isOurs: isOurClaudeHook,
    build: ({ nodePath, scriptPath }) => {
      const hook = (options) => ({ type: 'command', command: nodePath, args: [scriptPath, 'hook'], ...options });
      return {
        // Synchronous so the model is known before the first prompt. Takes a few milliseconds.
        SessionStart: [{ hooks: [hook({ timeout: 10 })] }],
        // In the background, so recording never slows the session down.
        UserPromptSubmit: [{ hooks: [hook({ async: true })] }],
        PostModelSwitch: [{ hooks: [hook({ async: true })] }],
      };
    },
    note: 'New Claude Code sessions pick the hooks up.',
  },
  codex: {
    isOurs: (hook) => isOurCommand(hook?.command),
    build: (paths) => ({ UserPromptSubmit: [{ hooks: [{ type: 'command', command: shellCommand(paths, 'codex'), timeout: 10 }] }] }),
    note: 'Codex runs a new hook only once you approve it: open Codex and approve "open-prompts" in /hooks.',
  },
  'gemini-cli': {
    isOurs: (hook) => hook?.name === 'open-prompts' || isOurCommand(hook?.command),
    build: (paths) => ({
      BeforeAgent: [{ hooks: [{ name: 'open-prompts', type: 'command', command: shellCommand(paths, 'gemini-cli'), timeout: 10000 }] }],
    }),
    note: 'Gemini CLI runs hooks from its settings in trusted folders only. The extension works everywhere.',
  },
};

function installNested(agent, file, paths) {
  const target = TARGETS[agent];
  const config = withoutNested(readJson(file), target.isOurs);
  config.hooks ??= {};
  for (const [event, groups] of Object.entries(target.build(paths))) {
    config.hooks[event] = [...(config.hooks[event] ?? []), ...groups];
  }
  writeJson(file, config);
}

// Vibe's hooks.toml is TOML, so the entry lives in a block between two marker comments,
// which uninstall removes. A JSON string is also a valid TOML basic string.
const VIBE_BLOCK_START = '# >>> open-prompts: added by "open-prompts install". Remove it with "open-prompts uninstall --agent mistral-vibe".';
const VIBE_BLOCK_END = '# <<< open-prompts';
const VIBE_BLOCK = /\n*# >>> open-prompts:[^\n]*\n[\s\S]*?# <<< open-prompts[^\n]*\n?/;

function vibeBlock(paths) {
  return [
    VIBE_BLOCK_START,
    '[[hooks]]',
    'name = "open-prompts"',
    'type = "pre_agent"',
    'match = "main"',
    `command = ${JSON.stringify(shellCommand(paths, 'mistral-vibe'))}`,
    'timeout = 10.0',
    'description = "Records the prompts you type, in repositories that opted in to Open Prompts"',
    VIBE_BLOCK_END,
    '',
  ].join('\n');
}

const withoutVibeBlock = (text) => text.replace(VIBE_BLOCK, '\n').replace(/^\n+/, '');

function opencodeShim(paths) {
  const url = pathToFileURL(path.join(path.dirname(path.dirname(paths.scriptPath)), 'src', 'opencode-plugin.mjs')).href;
  return [
    '// Installed by open-prompts. Remove it with "open-prompts uninstall --agent opencode".',
    `export const OpenPrompts = async (input) => (await import(${JSON.stringify(url)})).OpenPrompts(input);`,
    '',
  ].join('\n');
}

/** Installs the hooks for one agent. Returns a note to show, if any. */
export function installAgent(agent, { nodePath, scriptPath, env = process.env }) {
  const file = configPath(agent, env);
  const paths = { nodePath, scriptPath };
  switch (agent) {
    case 'claude-code':
    case 'codex':
    case 'gemini-cli':
      installNested(agent, file, paths);
      return TARGETS[agent].note;
    case 'cursor': {
      const config = withoutFlat(readJson(file), (entry) => isOurCommand(entry?.command));
      config.version ??= 1;
      config.hooks.beforeSubmitPrompt = [...(config.hooks.beforeSubmitPrompt ?? []), { command: shellCommand(paths, 'cursor'), timeout: 10 }];
      writeJson(file, config);
      return 'Cursor reloads its hooks by itself.';
    }
    case 'copilot': {
      const powershell = `& '${nodePath.replace(/'/g, "''")}' '${scriptPath.replace(/'/g, "''")}' hook --agent copilot`;
      const entry = { type: 'command', bash: shellCommand(paths, 'copilot'), powershell, timeoutSec: 10 };
      writeJson(file, { version: 1, hooks: { userPromptSubmitted: [entry] } });
      return null;
    }
    case 'opencode':
      writeFile(file, opencodeShim(paths));
      return 'OpenCode loads the plugin when it starts.';
    case 'mistral-vibe': {
      const kept = fs.existsSync(file) ? withoutVibeBlock(fs.readFileSync(file, 'utf8')).trimEnd() : '';
      writeFile(file, `${kept ? `${kept}\n\n` : ''}${vibeBlock(paths)}`);
      return 'New Vibe sessions pick the hook up.';
    }
    default:
      throw new Error(`unknown agent "${agent}"`);
  }
}

/** Removes the hooks for one agent. Returns whether anything was removed. */
export function uninstallAgent(agent, { env = process.env } = {}) {
  const file = configPath(agent, env);
  if (!fs.existsSync(file)) return false;
  if (agent === 'copilot' || agent === 'opencode') {
    fs.rmSync(file);
    return true;
  }
  if (agent === 'mistral-vibe') {
    const before = fs.readFileSync(file, 'utf8');
    if (!VIBE_BLOCK.test(before)) return false;
    const after = withoutVibeBlock(before).trimEnd();
    writeFile(file, after ? `${after}\n` : '');
    return true;
  }
  const before = readJson(file);
  const after =
    agent === 'cursor' ? withoutFlat(before, (entry) => isOurCommand(entry?.command)) : withoutNested(before, TARGETS[agent].isOurs);
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  writeJson(file, after);
  return true;
}

export function isAgentInstalled(agent, env = process.env) {
  const file = configPath(agent, env);
  if (!fs.existsSync(file)) return false;
  if (agent === 'copilot' || agent === 'opencode') return true;
  if (agent === 'mistral-vibe') return VIBE_BLOCK.test(fs.readFileSync(file, 'utf8'));
  try {
    const config = readJson(file);
    if (agent === 'cursor') return (config.hooks?.beforeSubmitPrompt ?? []).some((entry) => isOurCommand(entry?.command));
    return hasNested(config, TARGETS[agent].isOurs);
  } catch {
    return false;
  }
}

/** Our hooks in a `{ hooks: { Event: [group...] } }` map, as a flat list. */
const nestedHooks = (config, isOurs) =>
  Object.values(config.hooks ?? {}).flatMap((groups) => (Array.isArray(groups) ? groups.flatMap((group) => (group.hooks ?? []).filter(isOurs)) : []));

/**
 * The Node.js and script paths our installed hooks run for `agent`, as [{ nodePath, scriptPath }].
 * OpenCode runs the plugin in its own runtime, so only the script is known.
 */
export function installedPaths(agent, env = process.env) {
  const file = configPath(agent, env);
  if (!fs.existsSync(file)) return [];
  try {
    if (agent === 'opencode') {
      const url = /import\(("file:[^"]+")\)/.exec(fs.readFileSync(file, 'utf8'))?.[1];
      return url ? [{ nodePath: null, scriptPath: fileURLToPath(JSON.parse(url)) }] : [];
    }
    if (agent === 'mistral-vibe') {
      const block = VIBE_BLOCK.exec(fs.readFileSync(file, 'utf8'))?.[0] ?? '';
      const command = /^command = (".*")$/m.exec(block)?.[1];
      return command ? [commandPaths(JSON.parse(command))] : [];
    }
    const config = readJson(file);
    if (agent === 'claude-code') {
      return nestedHooks(config, isOurClaudeHook).map((hook) => ({ nodePath: hook.command, scriptPath: hook.args.find((arg) => /[\\/]bin[\\/]open-prompts$/.test(String(arg))) }));
    }
    if (agent === 'copilot') return (config.hooks?.userPromptSubmitted ?? []).filter((entry) => typeof entry?.bash === 'string').map((entry) => commandPaths(entry.bash));
    if (agent === 'cursor') return (config.hooks?.beforeSubmitPrompt ?? []).filter((entry) => isOurCommand(entry?.command)).map((entry) => commandPaths(entry.command));
    return nestedHooks(config, TARGETS[agent].isOurs).filter((hook) => typeof hook.command === 'string').map((hook) => commandPaths(hook.command));
  } catch {
    return [];
  }
}

/**
 * The paths our hooks for `agent` run that no longer exist, such as a Node.js removed by a
 * version manager or a deleted worktree. A bare command such as `node` is looked up in the
 * PATH by the agent, so it is not checked.
 */
export function missingPaths(agent, env = process.env) {
  const missing = new Set();
  for (const { nodePath, scriptPath } of installedPaths(agent, env)) {
    for (const file of [nodePath, scriptPath]) {
      if (typeof file === 'string' && /[\\/]/.test(file) && !fs.existsSync(file)) missing.add(file);
    }
  }
  return [...missing];
}

/** Whether the Open Prompts plugin is enabled in Claude Code. */
export function isClaudePluginEnabled(env = process.env) {
  try {
    const enabled = readJson(configPath('claude-code', env)).enabledPlugins ?? {};
    return Object.entries(enabled).some(([id, on]) => id.startsWith('open-prompts@') && on);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// How long Claude Code keeps its transcripts

/** Claude Code deletes transcripts older than this many days unless cleanupPeriodDays says otherwise. */
export const CLAUDE_DEFAULT_CLEANUP_DAYS = 30;
/** Below this, `install` warns that `import` may find little: transcripts are the main source of past prompts. */
export const CLAUDE_CLEANUP_WARN_DAYS = 90;
/** What `--keep-transcripts` writes when no number of days is given. */
export const CLAUDE_KEEP_DAYS = 365;

/**
 * Claude Code's cleanupPeriodDays: { days, set, file }, where `days` is the period in effect
 * (the default when the setting is missing) and `set` tells whether the setting is there.
 */
export function claudeRetention(env = process.env) {
  const file = configPath('claude-code', env);
  let value;
  try {
    value = readJson(file).cleanupPeriodDays;
  } catch {
    value = undefined;
  }
  const set = typeof value === 'number' && Number.isFinite(value) && value >= 0;
  return { days: set ? value : CLAUDE_DEFAULT_CLEANUP_DAYS, set, file };
}

/**
 * A warning about Claude Code's retention, or null when transcripts are kept long enough.
 * Recording does not need transcripts, but `import` does, to find what was typed before.
 */
export function claudeRetentionWarning(env = process.env) {
  const { days, set, file } = claudeRetention(env);
  if (days >= CLAUDE_CLEANUP_WARN_DAYS) return null;
  const now = set ? `cleanupPeriodDays is ${days} in ${file}` : `${file} has no cleanupPeriodDays, so the default applies`;
  const effect = days === 0 ? 'Claude Code keeps no transcripts' : `Claude Code deletes transcripts after ${days} days`;
  return `${effect} (${now}). "open-prompts import" reads them to find past prompts. To keep them longer, run "open-prompts install --agent claude-code --keep-transcripts" (${CLAUDE_KEEP_DAYS} days) or add "cleanupPeriodDays": <days> to that file.`;
}

/** Writes cleanupPeriodDays into Claude Code's settings, keeping the rest and a backup. */
export function setClaudeRetention(days, env = process.env) {
  if (!Number.isInteger(days) || days < 1) throw new Error('--keep-transcripts takes a whole number of days, 1 or more');
  const file = configPath('claude-code', env);
  writeJson(file, { ...readJson(file), cleanupPeriodDays: days });
  return file;
}
