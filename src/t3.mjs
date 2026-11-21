// T3 Code (https://t3.codes) runs agents such as Claude Code, Codex and Gemini CLI for a
// person, and also lets agents send messages to each other's sessions. A session that T3
// starts has T3CODE_THREAD_ID in its environment, which hooks inherit. T3 stores every
// message of a thread in its SQLite database, with who wrote it, before the agent receives
// it. So the hook reads that database to tell the person's messages from the agents'.
//
// Reading it needs node:sqlite (Node 22.5 or later, without a flag from 22.13). On older
// Node, or when anything goes wrong, the hook falls back to the text rules in core.mjs.

import os from 'node:os';
import path from 'node:path';
import { cleanHostMarkup, realModel } from './core.mjs';
import { realPath as realPathOf } from './repo.mjs';

const RECENT_MESSAGES = 20;
const BUSY_TIMEOUT_MS = 200;

/** Where T3 Code keeps its database. OPEN_PROMPTS_T3_DB overrides it, for tests. */
export const t3Database = (env = process.env) => env.OPEN_PROMPTS_T3_DB || path.join(os.homedir(), '.t3', 'userdata', 'statev2.sqlite');

/** The T3 thread the agent runs in, or null when T3 Code did not start it. */
export function t3Thread(env = process.env) {
  const thread = env.T3CODE_THREAD_ID;
  return typeof thread === 'string' && thread.trim() !== '' ? thread.trim() : null;
}

/**
 * Loads node:sqlite, or returns null when this Node has none. Node prints an
 * ExperimentalWarning on stderr when it loads, which a hook must not do, so that one
 * warning is dropped while the module loads.
 */
export async function loadSqlite() {
  const emitWarning = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type ?? warning?.name;
    if (type === 'ExperimentalWarning' && /sqlite/i.test(String(warning?.message ?? warning))) return;
    return emitWarning.call(this, warning, ...rest);
  };
  try {
    const sqlite = await import('node:sqlite');
    return typeof sqlite.DatabaseSync === 'function' ? sqlite : null;
  } catch {
    return null;
  } finally {
    process.emitWarning = emitWarning;
  }
}

/**
 * The text used to match a hook's prompt with T3's copy: cleaned the same way, without
 * attachment placeholders (T3 keeps attachments outside the text, the agent gets them
 * inside), with spaces collapsed.
 */
export const matchKey = (text) =>
  cleanHostMarkup(String(text ?? ''))
    .replace(/\[(?:image|file)\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const parse = (json) => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

/**
 * Finds the stored message that a prompt is, among the latest user messages of a thread
 * (newest first): the same text once cleaned, or, for a long prompt, the same first 200
 * characters, since hosts add or reshape markup at the end (attachments, quotes).
 */
export function matchMessage(prompt, messages) {
  const key = matchKey(prompt);
  if (key === '') return null;
  const keyed = messages.map((message) => ({ message, key: matchKey(message?.text) }));
  // An exact match first, so that a long prompt typed twice with different endings finds its own copy.
  return (keyed.find((entry) => entry.key === key) ?? keyed.find((entry) => sameKey(key, entry.key)))?.message ?? null;
}

/** Whether two match keys are the same prompt: equal, or long and equal over their first 200 characters. */
export const sameKey = (a, b) => a !== '' && (a === b || (a.length >= 40 && b.length >= 40 && a.slice(0, 200) === b.slice(0, 200)));

/**
 * Asks T3 Code's database what it knows about a prompt submitted in `session`.
 * Returns null outside T3. Otherwise returns:
 * - `extensions`: the record's extension fields, { x_host: "t3", x_thread },
 * - `automated`: a reason to skip the prompt (a sub-agent's thread, a message an agent
 *   wrote), or null,
 * - `typed`: true when T3 says the person wrote it, false when it does not know,
 * - `note`: why the database could not answer, for the debug log.
 * Never throws: every failure leaves the decision to the text rules.
 */
export async function t3Origin(prompt, { env = process.env, session } = {}) {
  const thread = t3Thread(env);
  if (!thread) return null;
  const origin = { extensions: { x_host: 't3', x_thread: thread }, automated: null, typed: false, note: null };
  const { db, note } = await openT3Database(env);
  if (!db) return { ...origin, note: `${note}; using text rules` };
  try {
    return { ...origin, ...lookUp(db, thread, prompt, session) };
  } catch (error) {
    return { ...origin, note: `T3 Code's database could not be read (${error?.message ?? error}); using text rules` };
  } finally {
    closeQuietly(db);
  }
}

/**
 * Opens T3 Code's database read-only. Returns { db }, or { note } saying why it cannot:
 * no node:sqlite in this Node.js, or no readable database.
 */
export async function openT3Database(env = process.env, { busyTimeoutMs = BUSY_TIMEOUT_MS } = {}) {
  const sqlite = await loadSqlite();
  if (!sqlite) return { note: "node:sqlite is not available in this Node.js (22.13 or later reads T3 Code's database)" };
  let db;
  try {
    db = new sqlite.DatabaseSync(t3Database(env), { readOnly: true });
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    return { db };
  } catch (error) {
    closeQuietly(db);
    return { note: `T3 Code's database could not be read (${error?.message ?? error})` };
  }
}

export function closeQuietly(db) {
  try {
    db?.close();
  } catch {
    // Already closed.
  }
}

/** Adds the note of a T3 lookup to a hook's result, for the debug log. */
export const withT3Note = (result, origin) => (origin?.note ? { ...result, t3: origin.note } : result);

function lookUp(db, thread, prompt, session) {
  const row = db.prepare('SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ?').get(thread);
  if (!row) return { note: 'the T3 thread is not in the database; using text rules' };

  // T3CODE_THREAD_ID is inherited by everything the agent starts, such as another agent
  // run from a shell. That session is not T3's: it gets neither the fields nor T3's verdict.
  if (typeof session === 'string' && session !== '') {
    const natives = db
      .prepare('SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id = ?')
      .all(thread)
      .map((provider) => parse(provider.payload_json)?.nativeThreadRef?.nativeId);
    const settled = natives.length > 0 && natives.every((id) => typeof id === 'string' && id !== '' && !id.startsWith('pending'));
    if (settled && !natives.includes(session)) return { extensions: {}, note: 'this session is not one T3 Code runs for the thread; using text rules' };
  }

  if (parse(row.payload_json)?.lineage?.relationshipToParent === 'subagent') return { automated: "a sub-agent's thread in T3 Code" };
  const messages = db
    .prepare(`SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id = ? AND role = 'user' ORDER BY created_at DESC, message_id DESC LIMIT ${RECENT_MESSAGES}`)
    .all(thread)
    .map((message) => parse(message.payload_json))
    .filter((message) => message && typeof message.text === 'string');
  const message = matchMessage(prompt, messages);
  if (!message) return { note: 'no matching message in the T3 thread; using text rules' };
  if (message.createdBy === 'agent') return { automated: 'written by an agent, according to T3 Code' };
  if (message.createdBy === 'user') return { typed: true };
  return { note: `T3 Code does not say who wrote the message (${message.createdBy}); using text rules` };
}

// ---------------------------------------------------------------------------
// Importing past prompts from T3 Code's database

// How T3 Code names the agents it runs: drivers (claudeAgent) and provider instances
// (claudeAgent, claudeGemini, geminiCli, codex…). Instances are named by the person, so a
// name that starts like a known agent counts as that agent.
const T3_AGENTS = { claudeAgent: 'claude-code', codex: 'codex', geminiCli: 'gemini-cli', opencode: 'opencode', cursor: 'cursor', copilot: 'copilot' };
const T3_AGENT_PREFIXES = [
  [/^claude/i, 'claude-code'],
  [/^codex/i, 'codex'],
  [/^gemini/i, 'gemini-cli'],
  [/^opencode/i, 'opencode'],
];

/** The agent slug (SPEC.md section 4) of a T3 Code driver or provider instance. */
export function t3AgentSlug(driver, instance) {
  for (const name of [driver, instance]) if (T3_AGENTS[name]) return T3_AGENTS[name];
  for (const name of [instance, driver]) {
    const known = T3_AGENT_PREFIXES.find(([rule]) => rule.test(String(name ?? '')));
    if (known) return known[1];
  }
  const slug = String(instance ?? driver ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'unknown';
}

/** A native session ID T3 has learned, or null for none or one still pending. */
const nativeSession = (providerThread) => {
  const id = providerThread?.nativeThreadRef?.nativeId;
  return typeof id === 'string' && id !== '' && !id.startsWith('pending') ? id : null;
};

/** The rows of a query, or none when T3's schema has not got what it asks for. */
const rowsOfWith = (db, sql, ...params) => {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
};
const rowsOf = (db, sql) => rowsOfWith(db, sql);

/**
 * Reads what T3 Code knows about the repository: its projects, the worktrees and sessions
 * of their threads, and every user message of those threads.
 *
 * `match(dir)` is the repository's matcher (repo.mjs). A project belongs to the repository
 * when its workspace root matches strongly; a thread, when its project does, or when its
 * worktree matches strongly.
 *
 * Returns:
 * - `projects`: the repository's projects, as { id, title, root, threads },
 * - `hostPaths`: what T3 says about worktree paths, for the matcher (`mine`, `label`),
 * - `sessions`: native session ID → { thread, mine, automated }, where `automated` says why
 *   every prompt of that session is an agent's (a sub-agent's thread, for example),
 * - `prompts`: the user messages of the repository's threads, as import candidates. Messages
 *   an agent wrote are kept with `automated` set, so that the same prompt found in an agent's
 *   transcript is skipped too.
 */
export function readT3(db, match) {
  const json = (text) => parse(text) ?? {};
  const projects = new Map();
  for (const row of rowsOf(db, 'SELECT project_id, title, workspace_root FROM projection_projects')) {
    if (match(row.workspace_root).strength === 'strong') projects.set(row.project_id, { id: row.project_id, title: row.title, root: row.workspace_root, threads: 0 });
  }
  const titles = new Map(rowsOf(db, 'SELECT project_id, title FROM projection_projects').map((row) => [row.project_id, row.title]));
  const providerThreads = new Map(rowsOf(db, 'SELECT provider_thread_id, driver, payload_json FROM orchestration_v2_projection_provider_threads').map((row) => [row.provider_thread_id, { driver: row.driver, ...json(row.payload_json) }]));
  const runs = new Map(rowsOf(db, 'SELECT run_id, payload_json FROM orchestration_v2_projection_runs').map((row) => [row.run_id, json(row.payload_json)]));

  const threads = new Map();
  const hostPaths = new Map();
  for (const row of rowsOf(db, 'SELECT thread_id, project_id, payload_json FROM orchestration_v2_projection_threads')) {
    const payload = json(row.payload_json);
    const worktree = typeof payload.worktreePath === 'string' && payload.worktreePath !== '' ? payload.worktreePath : null;
    const project = projects.get(row.project_id);
    const mine = Boolean(project) || (worktree !== null && match(worktree).strength === 'strong');
    if (project) project.threads++;
    const title = project?.title ?? titles.get(row.project_id) ?? row.project_id;
    // Directories that still exist are matched by git; T3 tells about the ones that are gone.
    if (worktree && !hostPaths.get(realPathOf(worktree))?.mine) {
      hostPaths.set(realPathOf(worktree), { mine, label: mine ? `T3 Code worktree of project "${title}"` : `T3 Code puts it in another project ("${title}")` });
    }
    // A sub-agent's thread holds only what agents wrote. A thread an agent started for the
    // person (through T3's tools) holds the person's messages too, so there each message's
    // `createdBy` decides.
    const relationship = payload.lineage?.relationshipToParent;
    const automated = relationship === 'subagent' ? "a sub-agent's thread in T3 Code" : null;
    threads.set(row.thread_id, { id: row.thread_id, mine, automated, payload, fork: relationship === 'fork' || Boolean(payload.forkedFrom?.threadId) });
  }

  const sessions = new Map();
  for (const providerThread of providerThreads.values()) {
    const thread = threads.get(providerThread.appThreadId);
    const native = nativeSession(providerThread);
    if (thread && native) sessions.set(native, { thread: thread.id, mine: thread.mine, automated: thread.automated });
  }

  const prompts = [];
  const copies = new Set();
  const mine = [...threads.values()].filter((thread) => thread.mine).map((thread) => thread.id);
  const messages = mine.length === 0 ? [] : rowsOfWith(db, `SELECT message_id, thread_id, run_id, created_at, payload_json FROM orchestration_v2_projection_messages WHERE role = 'user' AND thread_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, message_id`, JSON.stringify(mine));
  for (const row of messages) {
    const thread = threads.get(row.thread_id);
    if (!thread?.mine) continue;
    const message = json(row.payload_json);
    if (typeof message.text !== 'string') continue;
    // A fork starts with a copy of its parent's messages, which were typed in the parent.
    if (thread.fork && typeof thread.payload.createdAt === 'string' && row.created_at < thread.payload.createdAt) continue;
    const prompt = cleanHostMarkup(message.text);
    const copy = `${row.created_at}\n${prompt}`;
    if (copies.has(copy)) continue;
    copies.add(copy);
    const run = runs.get(row.run_id ?? message.runId);
    const providerThread = providerThreads.get(run?.providerThreadId);
    const native = nativeSession(providerThread);
    const instance = run?.providerInstanceId ?? thread.payload.providerInstanceId;
    prompts.push({
      source: 't3',
      agent: t3AgentSlug(providerThread?.driver ?? providerThread?.nativeThreadRef?.driver, instance),
      agentVersion: null,
      model: realModel(run?.modelSelection?.model ?? thread.payload.modelSelection?.model),
      session: native ?? row.thread_id,
      knownSession: Boolean(native),
      id: row.message_id,
      timestamp: row.created_at,
      prompt,
      extensions: { x_host: 't3', x_thread: row.thread_id },
      automated:
        thread.automated ??
        (message.createdBy !== 'user'
          ? 'written by an agent, according to T3 Code'
          : message.idleCompaction
            ? 'sent by T3 Code when the person came back to an idle thread'
            : null),
      typed: message.createdBy === 'user' && !thread.automated && !message.idleCompaction,
    });
  }
  return { projects: [...projects.values()], hostPaths, sessions, prompts };
}
