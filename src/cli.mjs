// Command line interface: `open-prompts <command>`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { importTranscript } from './agents/claude-code.mjs';
import { isPaused } from './core.mjs';
import { completeDeferred, runHook } from './hook.mjs';
import { AGENTS, AGENT_NAMES, configPath, detectInstalledAgents, installAgent, isAgentInstalled, isClaudePluginEnabled, uninstallAgent } from './install.mjs';
import { CONFIG_FILE, DEFAULT_DIR, findProject, readConfig } from './project.mjs';
import { validateFileContent } from './record.mjs';
import { listFiles, readRecords } from './store.mjs';
import { logError, stateDir } from './state.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT_PATH = path.join(PACKAGE_ROOT, 'bin', 'open-prompts');
const VERSION = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;

const HELP = `open-prompts ${VERSION}
Commit the prompts behind your code. https://github.com/theophile-wallez/open-prompts

Usage: open-prompts <command> [options]

Commands:
  init [--dir <dir>]      Enable Open Prompts in the current repository
  status                  Show whether prompts are recorded here, and for which agents
  show [file|session]     Print recorded prompts in a readable form
  validate [path...]      Check prompt files against the specification
  import <session|file>   Import a past Claude Code session (--all for every session of this project,
                          --dry-run to print what would be imported)
  pause / resume          Stop or restart recording on this machine
  install [--agent <a>]   Add the hooks to every agent found on this machine, or to one agent
  uninstall [--agent <a>] Remove them

Agents: ${AGENTS.join(', ')}

Set OPEN_PROMPTS=off in the environment to pause recording for one session.`;

class UsageError extends Error {}

function requireProject() {
  const project = findProject(process.cwd());
  if (!project) throw new UsageError(`This directory has not opted in. Run "open-prompts init" at the root of the repository first.`);
  return project;
}

const relative = (file) => path.relative(process.cwd(), file) || '.';

function findGitRoot(start) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

/** Whether this copy runs from a Claude Code plugin, where the plugin provides the hooks. */
function runsAsPlugin() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return Boolean(process.env.CLAUDE_PLUGIN_ROOT) || PACKAGE_ROOT.startsWith(path.join(configDir, 'plugins') + path.sep);
}

function hooksActive() {
  return runsAsPlugin() || isClaudePluginEnabled() || AGENTS.some((agent) => isAgentInstalled(agent));
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new UsageError(`${name} needs a value`);
  return value;
}

function agentOption(args) {
  const agent = optionValue(args, '--agent');
  if (agent !== undefined && !AGENTS.includes(agent)) throw new UsageError(`Unknown agent "${agent}". Agents: ${AGENTS.join(', ')}.`);
  return agent;
}

// ---------------------------------------------------------------------------

function cmdInit(args) {
  const dirIndex = args.indexOf('--dir');
  const dir = dirIndex >= 0 ? args[dirIndex + 1] : DEFAULT_DIR;
  if (!dir) throw new UsageError('--dir needs a value');

  const root = findGitRoot(process.cwd()) ?? process.cwd();
  const configPath = path.join(root, CONFIG_FILE);
  if (fs.existsSync(configPath)) {
    const config = readConfig(configPath);
    console.log(`Open Prompts is already enabled in ${root}. Prompts go to ${config.dir}/.`);
    return;
  }
  fs.writeFileSync(configPath, `${JSON.stringify({ version: 1, dir }, null, 2)}\n`);
  const config = readConfig(configPath); // validates `dir`
  const promptsDir = path.join(root, ...config.dir.split(/[\\/]/));
  fs.mkdirSync(promptsDir, { recursive: true });

  console.log(`Open Prompts is enabled in ${root}.`);
  console.log(`Prompts you type in Claude Code here will be written to ${relative(promptsDir)}/, one file per session.`);
  console.log(`Commit ${CONFIG_FILE} and ${config.dir}/ with your code.`);
  if (!findGitRoot(process.cwd())) console.log('\nNote: this directory is not a git repository.');
  if (!hooksActive()) {
    console.log('\nNo Open Prompts hooks found for any agent. Run "open-prompts install", or install the Claude Code plugin.');
  }
}

function cmdStatus() {
  const project = findProject(process.cwd());
  const lines = [];
  if (project) {
    const files = listFiles(project.promptsDir);
    const count = files.reduce((total, file) => total + readRecords(file).length, 0);
    lines.push(`Project:   ${project.root}`);
    lines.push(`Prompts:   ${relative(project.promptsDir)}/ (${count} prompts in ${files.length} sessions)`);
  } else {
    lines.push('Project:   not enabled here (run "open-prompts init")');
  }
  const agents = AGENTS.filter((agent) => isAgentInstalled(agent) || (agent === 'claude-code' && isClaudePluginEnabled())).map(
    (agent) => AGENT_NAMES[agent] + (agent === 'claude-code' && isClaudePluginEnabled() ? ' (plugin)' : ''),
  );
  lines.push(`Agents:    ${agents.length > 0 ? agents.join(', ') : 'none (run "open-prompts install")'}`);
  lines.push(`Recording: ${isPaused() ? 'paused' : 'on'}`);
  lines.push(`State:     ${stateDir()}`);
  console.log(lines.join('\n'));
}

function formatFile(file) {
  const records = readRecords(file);
  const first = records[0] ?? {};
  const agent = [first.agent, first.agent_version].filter(Boolean).join(' ');
  const out = [`${relative(file)}`, `  session ${first.session ?? '?'}${agent ? ` · ${agent}` : ''}`];
  records.forEach((record, index) => {
    const when = typeof record.timestamp === 'string' ? record.timestamp.replace('T', ' ').slice(0, 16) + ' UTC' : '?';
    out.push('', `  #${index + 1} · ${when} · ${record.model ?? 'unknown model'}`);
    for (const line of String(record.prompt ?? '').split('\n')) out.push(`  ${line}`);
  });
  return out.join('\n');
}

function cmdShow(args) {
  let files;
  const target = args[0];
  if (target && fs.existsSync(target) && fs.statSync(target).isFile()) {
    files = [path.resolve(target)];
  } else {
    const all = listFiles(requireProject().promptsDir);
    files = target ? all.filter((file) => readRecords(file)[0]?.session?.startsWith(target)) : all;
    if (target && files.length === 0) throw new UsageError(`No session starting with "${target}".`);
  }
  if (files.length === 0) {
    console.log('No prompts recorded yet.');
    return;
  }
  console.log(files.map(formatFile).join('\n\n'));
}

function cmdValidate(args) {
  let targets = args;
  const problems = [];
  if (targets.length === 0) {
    const project = findProject(process.cwd());
    targets = [project ? project.promptsDir : DEFAULT_DIR];
    if (project) {
      try {
        readConfig(project.configPath);
      } catch (error) {
        problems.push(error.message);
      }
    }
  }
  let checked = 0;
  for (const target of targets) {
    if (!fs.existsSync(target)) {
      problems.push(`${target}: not found`);
      continue;
    }
    const files = fs.statSync(target).isDirectory() ? listFiles(target) : [target];
    for (const file of files) {
      checked++;
      for (const { line, message } of validateFileContent(fs.readFileSync(file, 'utf8'), path.basename(file))) {
        problems.push(`${relative(file)}${line ? `:${line}` : ''}: ${message}`);
      }
    }
  }
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    console.error(`\n${problems.length} problem${problems.length > 1 ? 's' : ''} in ${checked} file${checked > 1 ? 's' : ''}.`);
    process.exitCode = 1;
  } else {
    console.log(`${checked} file${checked === 1 ? '' : 's'} checked, all valid.`);
  }
}

/** Claude Code stores transcripts under projects/<path with every non-alphanumeric character as "-">. */
function transcriptDir(root) {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(configDir, 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));
}

function cmdImport(args) {
  const project = requireProject();
  const dryRun = args.includes('--dry-run');
  const targets = args.filter((arg) => !arg.startsWith('--'));
  if (targets.length === 0 && !args.includes('--all')) throw new UsageError('Give a session ID, a transcript file, or --all.');
  const dir = transcriptDir(fs.realpathSync(project.root));
  let transcripts;
  if (args.includes('--all')) {
    transcripts = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).map((name) => path.join(dir, name)) : [];
    if (transcripts.length === 0) throw new UsageError(`No Claude Code sessions found in ${dir}.`);
  } else {
    transcripts = targets.map((arg) => {
      if (arg.endsWith('.jsonl') && fs.existsSync(arg)) return arg;
      const candidate = path.join(dir, `${arg}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
      throw new UsageError(`No transcript for "${arg}" in ${dir}.`);
    });
  }
  let written = 0;
  let skipped = 0;
  for (const transcript of transcripts) {
    const result = importTranscript(transcript, project, { dryRun });
    written += result.written;
    skipped += result.skipped;
    if (dryRun) {
      for (const record of result.records) {
        console.log(`\n${record.timestamp} · ${record.model ?? 'unknown model'}`);
        for (const line of record.prompt.split('\n')) console.log(`  ${line}`);
      }
    } else {
      for (const file of result.files) console.log(`${relative(file)}`);
    }
  }
  const verb = dryRun ? 'would be imported' : 'imported';
  console.log(`\n${written} prompt${written === 1 ? '' : 's'} ${verb}${skipped ? `, ${skipped} already there` : ''}.`);
  if (written > 0 && !dryRun) console.log('Read them before committing: redaction of secrets is best effort.');
}

function cmdPause(paused) {
  const marker = path.join(stateDir(), 'paused');
  if (paused) {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '');
    console.log('Recording is paused on this machine. Run "open-prompts resume" to start again.');
  } else {
    fs.rmSync(marker, { force: true });
    console.log('Recording is on.');
  }
}

function cmdInstall(args) {
  const only = agentOption(args);
  const agents = only ? [only] : detectInstalledAgents();
  if (agents.length === 0) throw new UsageError(`No supported agent found on this machine. Use --agent with one of: ${AGENTS.join(', ')}.`);
  for (const agent of agents) {
    if (agent === 'claude-code' && !only && isClaudePluginEnabled()) {
      console.log(`${AGENT_NAMES[agent]}: skipped, the Open Prompts plugin already provides the hooks.`);
      continue;
    }
    try {
      const note = installAgent(agent, { nodePath: process.execPath, scriptPath: SCRIPT_PATH });
      console.log(`${AGENT_NAMES[agent]}: hooks added to ${configPath(agent)}.${note ? `\n  ${note}` : ''}`);
    } catch (error) {
      console.error(`${AGENT_NAMES[agent]}: ${error.message}`);
      process.exitCode = 1;
    }
  }
  console.log('\nPrompts are recorded only in repositories where you ran "open-prompts init".');
}

function cmdUninstall(args) {
  const only = agentOption(args);
  for (const agent of only ? [only] : AGENTS) {
    try {
      if (uninstallAgent(agent)) console.log(`${AGENT_NAMES[agent]}: hooks removed from ${configPath(agent)}.`);
      else if (only) console.log(`${AGENT_NAMES[agent]}: no Open Prompts hooks in ${configPath(agent)}.`);
    } catch (error) {
      console.error(`${AGENT_NAMES[agent]}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

/**
 * Starts the background step of an adapter in a detached process, so the agent does not
 * wait for it. The payload goes through a private file in the state directory.
 */
function deferToBackground(agent, payload) {
  const dir = path.join(stateDir(), 'pending');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${Date.now()}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
  const child = spawn(process.execPath, [SCRIPT_PATH, 'hook-complete', agent, file], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return file;
}

/** The background step: waits for what the adapter needs, then writes the record. */
async function cmdHookComplete([agent, file]) {
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.rmSync(file, { force: true });
    debugLog({ agent, background: true, result: await completeDeferred(agent, payload) });
  } catch (error) {
    logError(stateDir(), error);
  }
}

/** Reads all of stdin. A stream, because a synchronous read fails with EAGAIN when the agent writes late. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function cmdHook(args) {
  if (process.stdin.isTTY) {
    console.error('"open-prompts hook" is run by coding agents, with the hook event as JSON on stdin.');
    return;
  }
  // Hooks must never disturb the agent: no stray output, no failure exit code.
  // If the agent stops the hook early, write the record right away instead of losing it.
  const controller = new AbortController();
  for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(name, () => controller.abort());
  let input;
  let agent;
  try {
    agent = optionValue(args, '--agent');
  } catch {
    agent = undefined;
  }
  try {
    input = JSON.parse(await readStdin());
    const { stdout, ...outcome } = await runHook(input, { agent, signal: controller.signal, defer: deferToBackground });
    if (stdout) process.stdout.write(stdout);
    debugLog({ input, ...outcome });
  } catch (error) {
    logError(stateDir(), error);
    debugLog({ input, error: String(error) });
  }
  process.exit(0);
}

/** With OPEN_PROMPTS_DEBUG=1, hooks log what they received and did to debug.log in the state directory. */
function debugLog(entry) {
  if (!process.env.OPEN_PROMPTS_DEBUG) return;
  try {
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'debug.log'), `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // Debugging must never break the agent either.
  }
}

// ---------------------------------------------------------------------------

const COMMANDS = {
  init: cmdInit,
  status: cmdStatus,
  show: cmdShow,
  validate: cmdValidate,
  import: cmdImport,
  pause: () => cmdPause(true),
  resume: () => cmdPause(false),
  install: cmdInstall,
  uninstall: cmdUninstall,
  hook: cmdHook,
  'hook-complete': cmdHookComplete,
};

export async function main(argv) {
  const [command, ...args] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }
  if (command === '--version' || command === '-v') {
    console.log(VERSION);
    return;
  }
  const run = COMMANDS[command];
  if (!run) {
    console.error(`Unknown command "${command}".\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  try {
    await run(args);
  } catch (error) {
    if (command === 'hook' || command === 'hook-complete') return;
    console.error(error instanceof UsageError ? error.message : `Error: ${error.message}`);
    process.exitCode = 1;
  }
}
