// Command line interface: `open-prompts <command>`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { claudeConfigDir, listTranscripts } from './agents/claude-code.mjs';
import { auditRecords, recordsOf, stagedRecords } from './audit.mjs';
import { SOURCES, parseSources, planImport } from './backfill.mjs';
import { isPaused, writePrompt } from './core.mjs';
import { completeDeferred, runHook } from './hook.mjs';
import {
  AGENTS,
  AGENT_NAMES,
  CLAUDE_KEEP_DAYS,
  claudeRetentionWarning,
  configPath,
  detectInstalledAgents,
  installAgent,
  isAgentInstalled,
  isClaudePluginEnabled,
  missingPaths,
  setClaudeRetention,
  uninstallAgent,
} from './install.mjs';
import { CONFIG_FILE, DEFAULT_DIR, findProject, readConfig } from './project.mjs';
import { MIN_NODE_MAJOR, installRuntime, nodeMajor, pickNode, removeRuntime, runtimeDir, runtimeInfo } from './runtime.mjs';
import { validateFileContent } from './record.mjs';
import { tildify } from './repo.mjs';
import { collect, spoolEnabled } from './spool.mjs';
import { STATS_GROUPS, formatStats, promptStats } from './stats.mjs';
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
  ui [--port <n>]         Browse, search and edit the prompts of this repository in your browser
                          (--no-open to only print the link, --offline to skip looking up
                          the authors' accounts and avatars)
  validate [path...]      Check prompt files against the specification
  audit [path...]         List what to read in prompt files before committing them: possible
                          secrets, emails, passwords, cookies, pasted logs (--staged for the
                          records added in staged changes only, as a pre-commit check)
  stats [--by <group>]    Count the prompts of this repository per day, model, session and
                          agent (--by day, model, session or agent, or a list such as
                          day,model, for some of them only; --json to print JSON)
  import <session|file>   Import past sessions: one session ID or file, or --all for every session
                          of this repository, in every checkout and worktree. --source claude,t3,
                          codex,gemini picks where to look (default: all). --dry-run prints which
                          folders matched and why, and what would be imported. Messages agents
                          wrote are skipped, and a prompt found in two places is written once
  collect [--dry-run]     Add the prompts of this repository that the hooks wrote in other
                          checkouts, such as a deleted worktree, and that are missing here. They
                          come from a local copy in the state directory, never published
  pause / resume          Stop or restart recording on this machine
  install [--agent <a>]   Add the hooks to every agent found on this machine, or to one agent.
                          They run a copy of open-prompts in ~/.local/share/open-prompts
                          (OPEN_PROMPTS_DATA_DIR), with a system-wide Node.js when the current
                          one belongs to a version manager such as nvm (--node <path> to pick
                          one). Run it again after updating open-prompts.
                          --keep-transcripts [days] also sets how long Claude Code keeps its
                          transcripts, which import reads (cleanupPeriodDays, 365 by default)
  uninstall [--agent <a>] Remove them. Without --agent, also removes the copy

Agents: ${AGENTS.join(', ')}

Options in .open-prompts.json: "redact" (emails, homePaths), "ignoreCommands" (slash commands
not to record, such as ["/clear"]), "ignore" (regular expressions), "spool" (false to keep
no local copy for collect) and "maxPasteLength" (characters: longer pasted text keeps its
first and last lines; off by default). See the README.

Under T3 Code, hooks ask T3's database who wrote each message (Node.js 22.13 or later) and add
"x_host" and "x_thread" to the records.

Set OPEN_PROMPTS=off in the environment to pause recording for one session, and
OPEN_PROMPTS_SPOOL=off to keep no local copy of the prompts for collect. OPEN_PROMPTS_DEBUG=1
logs hook events to debug.log, and OPEN_PROMPTS_STATE_DIR, OPEN_PROMPTS_DATA_DIR and
OPEN_PROMPTS_T3_DB move the state directory, the copy the hooks run and T3's database.`;

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
  const configDir = claudeConfigDir();
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
  // Git keeps no empty directory: without this file, a fresh clone has no prompts directory.
  const keep = path.join(promptsDir, '.gitkeep');
  if (!fs.existsSync(keep)) fs.writeFileSync(keep, '');

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
  // The copy the hooks run is updated by "install" only, not when this package is.
  const runtime = runtimeInfo();
  if (runtime) {
    const behind = runtime.version !== VERSION ? `, while this is ${VERSION}: run "open-prompts install" to update it` : '';
    lines.push(`Hooks run: ${tildify(runtimeDir())} (open-prompts ${runtime.version}${behind})`);
  }
  // Hooks that point to a Node.js or a script that is gone fail on every prompt.
  for (const agent of AGENTS.filter((name) => isAgentInstalled(name))) {
    const missing = missingPaths(agent);
    if (missing.length > 0) lines.push(`Broken:    ${AGENT_NAMES[agent]} runs ${missing.map(tildify).join(' and ')}, which no longer exist${missing.length === 1 ? 's' : ''}. Run "open-prompts install" again.`);
  }
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

/** Opens `url` in the default browser, without waiting for it and without failing. */
function openBrowser(url) {
  const [command, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The link is printed anyway.
  }
}

async function cmdUi(args) {
  const project = requireProject();
  const portValue = optionValue(args, '--port');
  const port = portValue === undefined ? 4319 : Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port needs a number between 0 and 65535');
  // Without --offline, authors are matched to their GitHub or GitLab account, and avatars downloaded.
  const offline = args.includes('--offline');
  const { startServer } = await import('./ui/server.mjs');
  let ui;
  try {
    ui = await startServer(project, { port, offline });
  } catch (error) {
    if (error.code !== 'EADDRINUSE' || portValue !== undefined) throw error;
    ui = await startServer(project, { port: 0, offline });
  }
  console.log(`Open Prompts for ${project.root}`);
  console.log(`\n  ${ui.url}\n`);
  console.log('Only this link opens the page. Press Ctrl+C to stop.');
  if (!args.includes('--no-open')) openBrowser(ui.url);
  const stop = async () => {
    await ui.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function cmdValidate(args) {
  let targets = args;
  const problems = [];
  // The prompts directory of a project that opted in may not exist yet: git keeps no empty
  // directory, and it is created with the first prompt.
  let optional = null;
  if (targets.length === 0) {
    const project = findProject(process.cwd());
    targets = [project ? project.promptsDir : DEFAULT_DIR];
    if (project) {
      optional = project.promptsDir;
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
      if (target !== optional) problems.push(`${target}: not found`);
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

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * Lists what to read before committing: `file:line: reason: excerpt`. Exits with 1 when
 * something is flagged. With --staged, only the records added in the staged changes.
 */
function cmdAudit(args) {
  const staged = args.includes('--staged');
  const targets = args.filter((arg) => !arg.startsWith('--'));
  const project = findProject(process.cwd());
  if (targets.length === 0 && !project) throw new UsageError('This directory has not opted in. Give the prompt files or directories to audit.');
  let entries;
  try {
    if (staged) entries = stagedRecords(targets.length > 0 ? targets : [relative(project.promptsDir)]);
    else entries = recordsOf(targets.length > 0 ? targets : [project.promptsDir].filter((dir) => fs.existsSync(dir)));
  } catch (error) {
    throw new UsageError(staged ? `audit --staged: ${error.message}` : error.message);
  }
  const findings = auditRecords(entries, { homePaths: project?.config.redact.homePaths ?? true });
  for (const { file, line, reason, excerpt } of findings) console.log(`${relative(file)}:${line}: ${reason}: ${excerpt}`);
  const what = staged ? `${plural(entries.length, 'staged record')}` : plural(entries.length, 'record');
  if (findings.length === 0) {
    console.log(`${what} checked, nothing flagged.`);
    return;
  }
  const records = new Set(findings.map(({ file, line }) => `${file}:${line}`)).size;
  console.log(`\n${plural(findings.length, 'finding')} in ${records} of ${what}. Read them, edit or delete the lines that should not be published, then commit. To delete a line, prefer "open-prompts ui": "open-prompts collect" adds back a line deleted by hand.`);
  process.exitCode = 1;
}

/**
 * Prompts per day, model, session and agent, from the project's prompt files. `--by` picks
 * the groups (repeated or separated by commas), `--json` prints them for programs.
 */
function cmdStats(args) {
  const project = requireProject();
  const by = optionValues(args, '--by').flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
  const unknown = by.find((group) => !STATS_GROUPS.includes(group));
  if (unknown) throw new UsageError(`Unknown group "${unknown}" for --by. Groups: ${STATS_GROUPS.join(', ')}.`);
  const records = listFiles(project.promptsDir).flatMap(readRecords);
  const stats = promptStats(records, by.length > 0 ? { by } : {});
  console.log(args.includes('--json') ? JSON.stringify(stats, null, 2) : formatStats(stats));
}

/** Every value of an option that can be repeated, such as `--source claude --source t3`. */
function optionValues(args, name) {
  const values = [];
  args.forEach((arg, index) => {
    if (arg === name) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new UsageError(`${name} needs a value`);
      values.push(value);
    } else if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1));
  });
  return values;
}

/** The arguments that are not options or option values. */
function positionals(args, withValues) {
  return args.filter((arg, index) => !arg.startsWith('--') && !withValues.includes(args[index - 1]));
}

const SOURCE_LABELS = { claude: 'folders', codex: 'directories', gemini: 'projects' };

/** One line per source: what it found for this repository. */
function sourceSummary(report) {
  const name = SOURCES[report.source];
  if (report.status === 'unavailable') return `${name}: not read, ${report.note} (${report.location})`;
  if (report.source === 't3') {
    if (report.status === 'none' && !report.matched) return `${name}: not found (${report.location})`;
    const projects = report.matched?.length ?? 0;
    return `${name}: ${plural(report.threads ?? 0, 'thread')} in ${plural(projects, 'project')} of this repository (${report.location})`;
  }
  if (report.status === 'none' && !report.matched) return `${name}: no sessions (${report.location})`;
  const sessions = (report.matched ?? []).reduce((total, group) => total + group.sessions, 0);
  if (sessions === 0) return `${name}: no sessions of this repository (${report.location})`;
  return `${name}: ${plural(sessions, 'session')} in ${report.matched.length} ${SOURCE_LABELS[report.source]} of ${report.location}`;
}

/** The folders or directories behind a source's summary, and why each one matched. */
function sourceDetails(report) {
  const lines = (report.matched ?? []).map(({ label, sessions, reason }) => `  ${label} (${plural(sessions, report.source === 't3' ? 'thread' : 'session')}): ${reason}`);
  for (const { label, sessions, reason } of report.rejected ?? []) lines.push(`  not used: ${label} (${plural(sessions, 'session')}): ${reason}`);
  return lines;
}

/** The notes after an import: when sources may hold more than what was found. */
function importNotes({ identity, oldest, sources }) {
  const notes = [];
  const DAY = 24 * 60 * 60 * 1000;
  if (identity.firstCommit && (!oldest || Date.parse(identity.firstCommit) < Date.parse(oldest) - DAY)) {
    const since = identity.firstCommit.slice(0, 10);
    const others = Object.keys(SOURCES).filter((name) => !sources.includes(name));
    notes.push(
      `The history of this repository starts on ${since}, ${oldest ? `but the oldest session found is from ${oldest.slice(0, 10)}` : 'and no session was found'}. ` +
        `Older prompts may be on another machine, in a tool open-prompts does not read${others.length > 0 ? `, or in a source left out here (--source ${others.join(',')})` : ''}, or deleted by the agent.`,
    );
  }
  if (sources.includes('claude')) {
    const warning = claudeRetentionWarning();
    if (warning && notes.length > 0) notes.push(warning);
  }
  return notes;
}

async function cmdImport(args) {
  const project = requireProject();
  const dryRun = args.includes('--dry-run');
  let sources;
  try {
    sources = parseSources(optionValues(args, '--source'));
  } catch (error) {
    throw new UsageError(error.message);
  }
  const targets = positionals(args, ['--source']);
  if (targets.length === 0 && !args.includes('--all')) throw new UsageError('Give a session ID, a session file, or --all.');
  const files = targets.filter((arg) => fs.existsSync(arg) && fs.statSync(arg).isFile()).map((arg) => path.resolve(arg));
  const ids = targets.filter((arg) => !files.includes(path.resolve(arg)));
  const plan = await planImport(project, { sources, files: files.length > 0 ? files : null, targets: args.includes('--all') ? null : ids.length > 0 ? ids : files.length > 0 ? [] : null });

  for (const id of ids) {
    if (plan.candidates.some((candidate) => candidate.session === id || (id.length >= 8 && candidate.session.startsWith(id)) || candidate.extensions?.x_thread === id)) continue;
    const elsewhere = listTranscripts().find((transcript) => transcript.session === id);
    throw new UsageError(
      elsewhere
        ? `Session "${id}" is in ${tildify(elsewhere.file)}, which does not belong to this repository. If it does, import the file: open-prompts import ${elsewhere.file}`
        : `No session "${id}" of this repository in ${sources.map((name) => SOURCES[name]).join(', ')}.`,
    );
  }

  if (files.length === 0) {
    for (const report of plan.reports) {
      console.log(sourceSummary(report));
      if (dryRun) for (const line of sourceDetails(report)) console.log(line);
    }
  }
  let written = 0;
  let skipped = plan.duplicates;
  let ignored = 0;
  const writtenFiles = new Set();
  for (const candidate of plan.write) {
    // The agents' own files are the source of these records, so they do not go to the spool.
    const result = writePrompt(project, candidate, { dryRun, spool: false });
    if (result.action === 'recorded') {
      written++;
      writtenFiles.add(result.file);
      if (dryRun) {
        console.log(`\n${result.record.timestamp} · ${result.record.agent} · ${result.record.model ?? 'unknown model'} · ${result.record.session}`);
        for (const line of result.record.prompt.split('\n')) console.log(`  ${line}`);
      }
    } else if (result.action === 'duplicate') skipped++;
    else ignored++;
  }
  if (!dryRun && writtenFiles.size > 0) console.log(`\n${[...writtenFiles].map(relative).join('\n')}`);
  const verb = dryRun ? 'would be imported' : 'imported';
  const notes = [
    skipped ? `${skipped} already there` : '',
    plan.automated.length ? `${plan.automated.length} written by agents or hosts, skipped` : '',
    ignored ? `${ignored} left out (empty, or listed in "ignore" or "ignoreCommands")` : '',
  ].filter(Boolean);
  console.log(`\n${plural(written, 'prompt')} ${verb}${notes.map((note) => `, ${note}`).join('')}.`);
  if (written > 0 && !dryRun) console.log('Read them before committing, starting with what "open-prompts audit" lists: redaction of secrets is best effort.');
  // The notes compare the whole history with every session found, so they only make sense with --all.
  if (files.length === 0 && args.includes('--all')) for (const note of importNotes({ identity: plan.identity, oldest: plan.oldest, sources })) console.log(`\nNote: ${note}`);
}

/**
 * Adds to this checkout's prompt files the records of the repository that the hooks wrote
 * in other checkouts, such as a deleted worktree, and that are missing here. They come from
 * the local spool in the state directory.
 */
function cmdCollect(args) {
  const project = requireProject();
  const dryRun = args.includes('--dry-run');
  const result = collect(project, { dryRun });
  for (const { file, record } of dryRun ? result.records : []) {
    console.log(`${relative(file)} · ${record.timestamp} · ${record.agent} · ${record.model ?? 'unknown model'}`);
    for (const line of record.prompt.split('\n')) console.log(`  ${line}`);
    console.log('');
  }
  if (!dryRun && result.files.length > 0) console.log(`${result.files.map(relative).join('\n')}\n`);
  const verb = dryRun ? 'would be added' : 'added';
  const sessions = new Set(result.records.map(({ record }) => record.session)).size;
  const notes = [result.present ? `${result.present} already there` : '', result.invalid ? `${plural(result.invalid, 'spooled line')} not valid, skipped` : ''].filter(Boolean);
  console.log(`${plural(result.added, 'prompt')} ${verb}${result.added ? ` in ${plural(sessions, 'session')}` : ''}${notes.map((note) => `, ${note}`).join('')}.`);
  if (result.added > 0 && !dryRun) console.log('Read them before committing, starting with what "open-prompts audit" lists.');
  for (const [checkout, count] of result.live) {
    console.log(`\nLeft out: ${plural(count, 'prompt')} of ${tildify(checkout)}, which still exists. Commit them there, or run "open-prompts collect" there.`);
  }
  for (const [file, count] of result.committed) {
    console.log(`\nLeft out: ${plural(count, 'prompt')} of ${relative(file)}, which is in git already, in another branch or deleted from it. Adding the file here would stop git from bringing that branch in. Check out the branch and run "open-prompts collect" there.`);
  }
  if (!spoolEnabled(project)) {
    const why = project.config.spool === false ? '"spool": false in .open-prompts.json' : 'OPEN_PROMPTS_SPOOL=off';
    console.log(`\nNote: the spool is off here (${why}), so new prompts are not kept for collect.`);
  }
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

/**
 * `--keep-transcripts [days]`: undefined when absent, else the number of days, or the
 * default when no number follows.
 */
function keepTranscriptsOption(args) {
  const index = args.indexOf('--keep-transcripts');
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) return CLAUDE_KEEP_DAYS;
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new UsageError('--keep-transcripts takes a whole number of days, 1 or more, such as --keep-transcripts 365');
  return Number(value);
}

/** `--node <path>`: the Node.js the hooks should run with, checked. */
function nodeOption(args) {
  const value = optionValue(args, '--node');
  if (value === undefined) return undefined;
  const nodePath = path.resolve(value);
  if (!fs.existsSync(nodePath)) throw new UsageError(`--node: ${value} does not exist`);
  const major = nodeMajor(nodePath);
  if (major === null) throw new UsageError(`--node: ${value} is not a Node.js that runs ("${value} --version" failed)`);
  if (major < MIN_NODE_MAJOR) throw new UsageError(`--node: ${value} is Node.js ${major}, and the hooks need ${MIN_NODE_MAJOR} or later`);
  return nodePath;
}

/**
 * Adds the hooks. They run a copy of open-prompts in the data directory, not this one,
 * which may be in a worktree or a cache that goes away, with a Node.js that stays in place.
 */
function cmdInstall(args) {
  const only = agentOption(args);
  const keepDays = keepTranscriptsOption(args);
  const chosenNode = nodeOption(args);
  const agents = only ? [only] : detectInstalledAgents();
  if (agents.length === 0) throw new UsageError(`No supported agent found on this machine. Use --agent with one of: ${AGENTS.join(', ')}.`);
  const skipped = (agent) => agent === 'claude-code' && !only && isClaudePluginEnabled();
  let runtime = null;
  let node = null;
  if (agents.some((agent) => !skipped(agent))) {
    runtime = installRuntime(PACKAGE_ROOT);
    node = chosenNode ? { nodePath: chosenNode, warning: null } : pickNode();
  }
  for (const agent of agents) {
    if (skipped(agent)) {
      console.log(`${AGENT_NAMES[agent]}: skipped, the Open Prompts plugin already provides the hooks.`);
      continue;
    }
    try {
      const note = installAgent(agent, { nodePath: node.nodePath, scriptPath: runtime.scriptPath });
      console.log(`${AGENT_NAMES[agent]}: hooks added to ${configPath(agent)}.${note ? `\n  ${note}` : ''}`);
    } catch (error) {
      console.error(`${AGENT_NAMES[agent]}: ${error.message}`);
      process.exitCode = 1;
    }
  }
  if (runtime) {
    const where = `${runtime.copied ? `Copied open-prompts ${VERSION} to` : `open-prompts ${VERSION} is up to date in`} ${tildify(runtime.dir)}`;
    console.log(`\n${where}. The hooks run it from there with ${tildify(node.nodePath)}.`);
    if (node.warning) console.log(`\nWarning: ${node.warning}`);
  }
  // Claude Code deletes old transcripts, which "import" needs. Only an explicit flag changes that.
  if (keepDays !== undefined) {
    try {
      console.log(`${AGENT_NAMES['claude-code']}: transcripts are kept for ${keepDays} days (cleanupPeriodDays in ${setClaudeRetention(keepDays)}).`);
    } catch (error) {
      console.error(`${AGENT_NAMES['claude-code']}: ${error.message}`);
      process.exitCode = 1;
    }
  } else if (agents.includes('claude-code')) {
    const warning = claudeRetentionWarning();
    if (warning) console.log(`\nNote: ${warning}`);
  }
  console.log('\nPrompts are recorded only in repositories where you ran "open-prompts init".');
}

/** Removes the hooks. For every agent, also removes the copy the hooks ran. */
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
  if (only || process.exitCode) return;
  try {
    if (removeRuntime()) console.log(`Removed the copy of open-prompts in ${tildify(runtimeDir())}.`);
  } catch (error) {
    console.error(`Could not remove ${runtimeDir()}: ${error.message}`);
    process.exitCode = 1;
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
  ui: cmdUi,
  validate: cmdValidate,
  audit: cmdAudit,
  stats: cmdStats,
  import: cmdImport,
  collect: cmdCollect,
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
