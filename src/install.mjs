// Installing the hooks into each agent's user configuration.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { copilotHome } from './agents/copilot.mjs';

export const AGENTS = ['claude-code', 'codex', 'cursor', 'gemini-cli', 'copilot', 'opencode'];

export const AGENT_NAMES = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  'gemini-cli': 'Gemini CLI',
  copilot: 'GitHub Copilot CLI',
  opencode: 'OpenCode',
};

const home = () => os.homedir();
const claudeDir = (env) => env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude');
const codexDir = (env) => env.CODEX_HOME || path.join(home(), '.codex');
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
  };
  return AGENTS.filter((agent) => dirs[agent].some((dir) => fs.existsSync(dir)));
}

// ---------------------------------------------------------------------------
// Commands and how to recognize ours

const quote = (value) => (process.platform === 'win32' ? `"${value}"` : `'${value.replace(/'/g, `'\\''`)}'`);
const shellCommand = ({ nodePath, scriptPath }, agent) => `${quote(nodePath)} ${quote(scriptPath)} hook --agent ${agent}`;
const OUR_COMMAND = /[\\/]bin[\\/]open-prompts['"]?\s+hook\b/;
const isOurCommand = (value) => typeof value === 'string' && OUR_COMMAND.test(value);

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
  try {
    const config = readJson(file);
    if (agent === 'cursor') return (config.hooks?.beforeSubmitPrompt ?? []).some((entry) => isOurCommand(entry?.command));
    return hasNested(config, TARGETS[agent].isOurs);
  } catch {
    return false;
  }
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
