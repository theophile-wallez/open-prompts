// `open-prompts import`: finds the past sessions of a repository in every source that
// keeps them (Claude Code transcripts, T3 Code's database, Codex rollouts, Gemini CLI
// chats), and turns their prompts into records once each.
//
// Each source gives import candidates: { source, agent, agentVersion, model, session, id,
// timestamp, prompt (cleaned), extensions, automated }. `automated` holds why the prompt is
// not a person's, when a rule or a host says so. The same prompt can come from two sources,
// such as a Claude Code transcript and T3 Code's database, with different IDs: `reconcile`
// pairs them and keeps one, and drops what the prompt files already hold.

import fs from 'node:fs';
import path from 'node:path';
import * as claude from './agents/claude-code.mjs';
import * as codex from './agents/codex.mjs';
import * as gemini from './agents/gemini-cli.mjs';
import { recordText } from './core.mjs';
import { repositoryIdentity, repositoryMatcher, tildify } from './repo.mjs';
import { listFiles, readRecords } from './store.mjs';
import { closeQuietly, matchKey, openT3Database, readT3, sameKey, t3Database } from './t3.mjs';

/** The sources `import` reads, by the name `--source` takes. */
export const SOURCES = { claude: 'Claude Code', t3: 'T3 Code', codex: 'Codex', gemini: 'Gemini CLI' };

/** Reads `--source` values (repeated, or a comma list). Throws on an unknown source. */
export function parseSources(values) {
  const names = values.flatMap((value) => value.split(',')).map((name) => name.trim().toLowerCase()).filter(Boolean);
  for (const name of names) {
    if (!SOURCES[name]) throw new Error(`Unknown source "${name}". Sources: ${Object.keys(SOURCES).join(', ')}.`);
  }
  return names.length > 0 ? [...new Set(names)] : Object.keys(SOURCES);
}

// How far apart two copies of the same prompt can be. A host such as T3 Code stores a
// message when the person sends it, and the agent when it starts the turn, which can be
// hours later for a message queued behind a long turn.
const SAME_PROMPT_BEFORE_MS = 6 * 60 * 60 * 1000;
const SAME_PROMPT_AFTER_MS = 2 * 60 * 1000;
// Without a shared session, only a copy this close in time counts as the same prompt.
const SAME_PROMPT_NO_SESSION_MS = 2 * 60 * 1000;


const time = (candidate) => Date.parse(candidate.timestamp);
const sameSecond = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1000;

/** Groups `items` into a map by `key(item)`. */
function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const name = key(item);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }
  return groups;
}

/**
 * Pairs T3 Code's copy of each prompt with the agent's copy, one to one, closest in time first.
 * The agent's copy is kept, with T3's extension fields and T3's verdict on who wrote it:
 * an agent's message is skipped, and a person's message is kept even if it looks like an
 * agent's. Returns the candidates left: the agent's, and T3's that had no pair.
 */
function pairWithHost(candidates, hostSessions) {
  const agents = candidates.filter((candidate) => candidate.source !== 't3');
  const host = candidates.filter((candidate) => candidate.source === 't3').sort((a, b) => time(a) - time(b));
  for (const candidate of agents) {
    candidate.key = matchKey(candidate.prompt);
    const session = hostSessions.get(candidate.session);
    if (session?.automated) candidate.automated = session.automated;
  }
  // Every pair that could be the same prompt, closest in time first, so that a prompt
  // typed again later does not take the place of the right copy.
  const bySession = groupBy(agents, (candidate) => candidate.session);
  const pairs = [];
  for (const copy of host) {
    const key = matchKey(copy.prompt);
    const at = time(copy);
    for (const candidate of copy.knownSession ? (bySession.get(copy.session) ?? []) : agents) {
      const gap = time(candidate) - at;
      const close = copy.knownSession ? gap >= -SAME_PROMPT_AFTER_MS && gap <= SAME_PROMPT_BEFORE_MS : Math.abs(gap) <= SAME_PROMPT_NO_SESSION_MS;
      if (close && (copy.knownSession ? sameKey(candidate.key, key) : candidate.key === key && key !== '')) pairs.push({ copy, candidate, distance: Math.abs(gap) });
    }
  }
  const pairedCopies = new Set();
  for (const { copy, candidate } of pairs.sort((a, b) => a.distance - b.distance)) {
    if (candidate.paired || pairedCopies.has(copy)) continue;
    candidate.paired = true;
    pairedCopies.add(copy);
    candidate.extensions = { ...candidate.extensions, ...copy.extensions };
    candidate.model ??= copy.model;
    if (copy.automated) candidate.automated = copy.automated;
    else if (copy.typed) candidate.automated = null;
  }
  const unpaired = host.filter((copy) => !pairedCopies.has(copy) && !copy.verdictOnly);
  return [...agents, ...unpaired];
}

/**
 * Decides which candidates to write. Returns { write, duplicates, automated }, where
 * `write` is in order of time, `duplicates` counts the prompts found twice or already in
 * the prompt files, and `automated` lists the candidates skipped with their reason.
 *
 * `existing` holds the records of the prompt files. A candidate is already there when a
 * record has its ID, or the same session, the same text once shortened and redacted with
 * the options of `project` (as writePrompt does), and a close time. A candidate without an
 * ID is also there when a record without one has its session and time, to the second.
 */
export function reconcile(candidates, { existing = [], hostSessions = new Map(), project = null } = {}) {
  const automated = [];
  let duplicates = 0;
  const kept = [];
  for (const candidate of pairWithHost(candidates.map((candidate) => ({ ...candidate })), hostSessions)) {
    if (candidate.automated) automated.push(candidate);
    else kept.push(candidate);
  }

  // A session forked or resumed into a new one copies its prompts, IDs included: the copy
  // in the session that started first is the one the person typed.
  const starts = new Map();
  for (const candidate of kept) starts.set(candidate.session, Math.min(starts.get(candidate.session) ?? Infinity, time(candidate) || Infinity));
  const firstOfId = new Map();
  for (const candidate of kept) {
    if (!candidate.id) continue;
    const name = `${candidate.agent}\n${candidate.id}`;
    const other = firstOfId.get(name);
    if (!other || starts.get(candidate.session) < starts.get(other.session)) firstOfId.set(name, candidate);
  }

  const records = existing.map((record) => ({ id: record.id, session: record.session, key: matchKey(record.prompt), at: Date.parse(record.timestamp), used: false }));
  const ids = new Map(records.filter((record) => record.id).map((record) => [record.id, record]));
  const recorded = groupBy(records, (record) => record.session);
  const write = [];
  const ordered = kept.sort((a, b) => time(a) - time(b));
  // A record with a candidate's ID is that prompt, so it cannot stand for another one with the same text.
  for (const candidate of ordered) if (candidate.id && ids.has(candidate.id) && firstOfId.get(`${candidate.agent}\n${candidate.id}`) === candidate) ids.get(candidate.id).used = true;
  for (const candidate of ordered) {
    if (candidate.id && firstOfId.get(`${candidate.agent}\n${candidate.id}`) !== candidate) {
      duplicates++;
      continue;
    }
    if (candidate.id && ids.has(candidate.id)) {
      duplicates++;
      continue;
    }
    const key = matchKey(recordText(project, candidate.prompt, candidate.pastes).text);
    const match = (recorded.get(candidate.session) ?? []).find(
      (record) => !record.used && sameKey(record.key, key) && Math.abs(record.at - time(candidate)) <= SAME_PROMPT_BEFORE_MS,
    );
    // Without an ID, a record of the same session and second is that prompt, whatever its
    // text, so that a line a person edited by hand, for example to remove a secret, is not
    // written again in its first form (as `collect` does, see spool.mjs recordKey).
    const edited = match || candidate.id ? null : (recorded.get(candidate.session) ?? []).find((record) => !record.used && !record.id && sameSecond(record.at, time(candidate)));
    if (match || edited) {
      (match ?? edited).used = true;
      duplicates++;
      continue;
    }
    write.push(candidate);
  }
  return { write, duplicates, automated };
}

// ---------------------------------------------------------------------------
// Finding the sessions of a repository in each source

/** What a found session or folder adds to the report: a label, the reason and its strength. */
function tally(groups, label, decision) {
  // Sessions left out are grouped by reason too, since one directory can have several.
  const key = decision.strength ? label : `${label}\n${decision.reason}`;
  const group = groups.get(key) ?? { label, reason: decision.reason, strength: decision.strength, sessions: 0 };
  // The strongest reason seen for the group is the one reported.
  if (group.strength !== 'strong' && decision.strength === 'strong') Object.assign(group, { reason: decision.reason, strength: 'strong' });
  group.sessions++;
  groups.set(key, group);
}

const wanted = (targets, session) => !targets || targets.some((target) => session === target || (target.length >= 8 && session.startsWith(target)));

/**
 * Finds the Claude Code transcripts of the repository. A transcript belongs to it when its
 * working directory does (see repo.mjs), or when T3 Code says its session is a thread of the
 * repository. A weak match is dropped when T3 Code puts the session in another project.
 */
function claudeSessions({ match, t3, targets, env, transcripts }) {
  const location = tildify(claude.claudeProjectsDir(env));
  if (transcripts.length === 0) return { report: { source: 'claude', location, status: 'none' }, files: [] };
  const matched = new Map();
  const rejected = new Map();
  const files = [];
  for (const transcript of transcripts) {
    if (!wanted(targets, transcript.session)) continue;
    const head = claude.transcriptHead(transcript.file);
    const host = t3?.sessions.get(transcript.session);
    let decision = head.cwd ? match(head.cwd) : { strength: null, reason: 'no working directory in the transcript' };
    if (host?.mine && decision.strength !== 'strong') decision = { strength: 'strong', reason: 'a session of a T3 Code thread of this repository' };
    if (host && !host.mine && decision.strength === 'weak') decision = { strength: null, reason: `${decision.reason}, contradicted: T3 Code puts the session in another project`, contradicted: true };
    if (decision.strength) {
      tally(matched, transcript.folder, decision);
      files.push({ ...transcript, version: head.version });
    } else if (decision.contradicted) tally(rejected, transcript.folder, decision);
  }
  return { report: { source: 'claude', location, status: files.length > 0 ? 'found' : 'none', matched: [...matched.values()], rejected: [...rejected.values()] }, files };
}

/** Finds the Codex rollouts of the repository, by the working directory of each session. */
function codexSessions({ match, t3, targets, env }) {
  const location = tildify(path.join(codex.codexHome(env), 'sessions'));
  const rollouts = codex.listRollouts(env);
  if (rollouts.length === 0) return { report: { source: 'codex', location, status: 'none' }, files: [] };
  const imported = codex.importedSessions(env);
  const matched = new Map();
  const rejected = new Map();
  const files = [];
  for (const file of rollouts) {
    const meta = codex.rolloutMeta(file);
    if (!meta?.id || !wanted(targets, meta.id)) continue;
    const host = t3?.sessions.get(meta.id);
    let decision = match(meta.cwd);
    if (host?.mine && decision.strength !== 'strong') decision = { strength: 'strong', reason: 'a session of a T3 Code thread of this repository' };
    if (host && !host.mine && decision.strength === 'weak') decision = { strength: null, reason: `${decision.reason}, contradicted: T3 Code puts the session in another project`, contradicted: true };
    if (!decision.strength) {
      if (decision.contradicted) tally(rejected, tildify(meta.cwd), decision);
      continue;
    }
    const skip = codex.skippedSession(meta, imported);
    if (skip) {
      tally(rejected, tildify(meta.cwd), { strength: null, reason: `skipped: ${skip}` });
      continue;
    }
    tally(matched, tildify(meta.cwd), decision);
    files.push(file);
  }
  return { report: { source: 'codex', location, status: files.length > 0 ? 'found' : 'none', matched: [...matched.values()], rejected: [...rejected.values()] }, files, imported };
}

/**
 * Finds the Gemini CLI chats of the repository, by the project path Gemini CLI wrote down,
 * or by the hash of the path for older versions, compared with the repository's worktrees.
 */
function geminiSessions({ match, identity, t3, targets, env }) {
  const location = tildify(path.join(gemini.geminiDir(env), 'tmp'));
  const chats = gemini.listGeminiChats(env);
  if (chats.length === 0) return { report: { source: 'gemini', location, status: 'none' }, files: [] };
  const known = [...identity.worktrees, ...[...(t3?.hostPaths ?? new Map())].filter(([, host]) => host.mine).map(([dir]) => dir)];
  const hashes = new Map(known.map((dir) => [gemini.projectHash(dir), dir]));
  const matched = new Map();
  const rejected = new Map();
  const files = [];
  for (const chat of chats) {
    const { meta } = gemini.readGeminiChat(chat.file);
    if (!meta?.sessionId || !wanted(targets, meta.sessionId)) continue;
    const root = chat.root ?? hashes.get(meta.projectHash ?? chat.dirName) ?? null;
    const decision = root ? match(root) : { strength: null, reason: 'unknown project' };
    if (decision.strength) {
      tally(matched, tildify(root), decision);
      files.push(chat.file);
    } else if (decision.contradicted) tally(rejected, tildify(root), decision);
  }
  return { report: { source: 'gemini', location, status: files.length > 0 ? 'found' : 'none', matched: [...matched.values()], rejected: [...rejected.values()] }, files };
}

/** The agent version of a session, from its transcript when it is still on disk. */
function versionFinder(transcripts, env) {
  const byClaudeSession = new Map(transcripts.map((transcript) => [transcript.session, transcript.file]));
  let rollouts = null;
  const cache = new Map();
  return (agent, session) => {
    const key = `${agent}\n${session}`;
    if (cache.has(key)) return cache.get(key);
    let version = null;
    if (agent === 'claude-code' && byClaudeSession.has(session)) version = claude.transcriptHead(byClaudeSession.get(session)).version;
    if (agent === 'codex') {
      rollouts ??= codex.listRollouts(env);
      const file = rollouts.find((name) => path.basename(name).includes(session));
      version = file ? (codex.rolloutMeta(file)?.cli_version ?? null) : null;
    }
    cache.set(key, version);
    return version;
  };
}

/**
 * Finds the sessions of the project's repository in `sources` and reads their prompts.
 * `targets` limits the search to session IDs (or prefixes of 8 characters or more), or to
 * none with []. `files` also reads these session files, whatever their directory, with
 * T3 Code's copies of their prompts.
 *
 * Returns { identity, reports, candidates, hostSessions }: one report per source, with
 * the folders or directories that matched and why, and the import candidates.
 */
export async function findSessions(project, { sources = Object.keys(SOURCES), targets = null, files = null, env = process.env } = {}) {
  const identity = repositoryIdentity(project.root);
  const baseMatch = repositoryMatcher(identity);
  const reports = [];

  // T3 Code's database also tells which directories and sessions are this repository's,
  // and who wrote each message, so it is read whenever it can be, whatever `sources` says.
  const { db, note } = await openT3Database(env, { busyTimeoutMs: 2000 });
  let t3 = null;
  try {
    if (db) t3 = readT3(db, baseMatch);
  } catch (error) {
    t3 = null;
    reports.push({ source: 't3', location: tildify(t3Database(env)), status: 'unavailable', note: `could not be read (${error?.message ?? error})` });
  } finally {
    closeQuietly(db);
  }
  const match = repositoryMatcher(identity, { hostPaths: t3?.hostPaths ?? new Map() });

  const candidates = [];
  const transcripts = claude.listTranscripts(env);
  for (const file of files ?? []) candidates.push(...promptsOfFile(file));
  // Files given on the command line are read whatever their folder; the sources are searched
  // for the whole repository, or for the session IDs given.
  const fromFiles = new Set(candidates.map((candidate) => candidate.session));
  const scan = !files || targets === null || targets.length > 0;
  if (scan) {
    if (sources.includes('claude')) {
      const found = claudeSessions({ match, t3, targets, env, transcripts });
      reports.push(found.report);
      for (const { file } of found.files) candidates.push(...claude.transcriptPrompts(file));
    }
    if (sources.includes('codex')) {
      const found = codexSessions({ match, t3, targets, env });
      reports.push(found.report);
      for (const file of found.files) candidates.push(...codex.rolloutPrompts(file, { imported: found.imported }));
    }
    if (sources.includes('gemini')) {
      const found = geminiSessions({ match, identity, t3, targets, env });
      reports.push(found.report);
      for (const file of found.files) candidates.push(...gemini.chatPrompts(file));
    }
  }
  // Without --source t3, T3's copies still say who wrote the prompts found elsewhere, but
  // a prompt only T3 has is not written.
  if (t3 && !sources.includes('t3')) {
    const sessions = new Set(candidates.map((candidate) => candidate.session));
    for (const prompt of t3.prompts) if (sessions.has(prompt.session)) candidates.push({ ...prompt, verdictOnly: true });
  }
  if (sources.includes('t3') && !reports.some((report) => report.source === 't3')) {
    const location = tildify(t3Database(env));
    if (!t3) {
      reports.push({ source: 't3', location, status: fs.existsSync(t3Database(env)) ? 'unavailable' : 'none', note });
    } else {
      const version = versionFinder(transcripts, env);
      const inTargets = (prompt) => scan && (wanted(targets, prompt.session) || wanted(targets, prompt.extensions.x_thread));
      const prompts = t3.prompts.filter((prompt) => fromFiles.has(prompt.session) || inTargets(prompt));
      for (const prompt of prompts) candidates.push({ ...prompt, agentVersion: version(prompt.agent, prompt.session) });
      const threads = new Set(prompts.map((prompt) => prompt.extensions.x_thread)).size;
      reports.push({
        source: 't3',
        location,
        status: prompts.length > 0 ? 'found' : 'none',
        matched: t3.projects.map((project) => ({ label: `project "${project.title}"`, reason: `workspace ${tildify(project.root)}: ${match(project.root).reason}`, strength: 'strong', sessions: project.threads })),
        threads,
      });
    }
  }
  return { identity, reports, candidates, hostSessions: t3?.sessions ?? new Map() };
}

/** The prompts of one file given on the command line: a Claude Code transcript, a Codex rollout or a Gemini CLI chat. */
export function promptsOfFile(file) {
  if (codex.rolloutMeta(file)) return codex.rolloutPrompts(file, { imported: new Set() });
  if (file.endsWith('.json') || gemini.readGeminiChat(file).meta?.projectHash) return gemini.chatPrompts(file);
  return claude.transcriptPrompts(file);
}

/** Every record already in the project's prompt files. */
export function existingRecords(project) {
  return listFiles(project.promptsDir).flatMap((file) => {
    try {
      return readRecords(file);
    } catch {
      return [];
    }
  });
}

/** Finds the project's sessions and decides what to write. See findSessions and reconcile. */
export async function planImport(project, options = {}) {
  const found = await findSessions(project, options);
  const plan = reconcile(found.candidates, { existing: existingRecords(project), hostSessions: found.hostSessions, project });
  const times = found.candidates.filter((candidate) => !candidate.verdictOnly).map(time).filter(Number.isFinite);
  return { ...found, ...plan, oldest: times.length > 0 ? new Date(Math.min(...times)).toISOString() : null };
}
