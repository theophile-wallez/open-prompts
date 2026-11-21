// `open-prompts import`: finding a repository's sessions in every source, and writing each
// prompt once. Every source lives in a temporary directory: CLAUDE_CONFIG_DIR, CODEX_HOME,
// GEMINI_CLI_HOME and OPEN_PROMPTS_T3_DB point there.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chatPrompts, projectHash } from '../src/agents/gemini-cli.mjs';
import { cleanCodexPrompt, handle as codexHook, rolloutPrompts } from '../src/agents/codex.mjs';
import { parseSources, planImport, reconcile } from '../src/backfill.mjs';
import { claudeRetention, claudeRetentionWarning, setClaudeRetention } from '../src/install.mjs';
import { findProject } from '../src/project.mjs';
import { looksLikeWorktreeOf, repositoryIdentity, repositoryMatcher } from '../src/repo.mjs';
import { loadSqlite, readT3, t3AgentSlug } from '../src/t3.mjs';
import { optedInRepo, readJsonl, tempDir } from './helpers.mjs';

const sqlite = await loadSqlite();
const skip = sqlite ? false : 'node:sqlite is not available in this Node.js';
const BIN = fileURLToPath(new URL('../bin/open-prompts', import.meta.url));

// ---------------------------------------------------------------------------
// Fixtures

const realTemp = (prefix) => fs.realpathSync(tempDir(prefix));
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: path.join(realTemp('open-prompts-gitconfig-'), 'config'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_AUTHOR_DATE: '2026-01-05T10:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-05T10:00:00Z',
};

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A git repository named `name` that opted in, in its own temporary directory. */
function repository(name = 'my-app') {
  const root = path.join(realTemp('open-prompts-repos-'), name);
  fs.mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, '.open-prompts.json'), JSON.stringify({ version: 1, dir: 'prompts' }));
  git(root, 'add', '-A');
  // The name makes each repository's root commit its own, even with the same dates.
  git(root, 'commit', '-q', '-m', `first commit of ${name}`);
  return root;
}

/** Temporary homes for every source, and the environment that points to them. */
function sources() {
  const home = realTemp('open-prompts-sources-');
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
    CODEX_HOME: path.join(home, 'codex'),
    GEMINI_CLI_HOME: path.join(home, 'gemini-home'),
    OPEN_PROMPTS_T3_DB: path.join(home, 'no-t3.sqlite'),
    OPEN_PROMPTS_STATE_DIR: path.join(home, 'state'),
    OPEN_PROMPTS: '',
  };
  return { home, env };
}

const jsonl = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;

/** Writes a Claude Code transcript for `cwd`, in the folder Claude Code would use. */
function claudeTranscript(env, cwd, session, prompts, { folder = cwd.replace(/[^A-Za-z0-9]/g, '-'), model = 'claude-opus-5-5' } = {}) {
  const dir = path.join(env.CLAUDE_CONFIG_DIR, 'projects', folder);
  fs.mkdirSync(dir, { recursive: true });
  const entries = prompts.flatMap(({ id, text, at }) => [
    { type: 'user', sessionId: session, cwd, version: '2.1.328', promptId: id, uuid: `u-${id}`, timestamp: at, message: { role: 'user', content: text } },
    { type: 'assistant', sessionId: session, cwd, message: { model, content: [] } },
  ]);
  const file = path.join(dir, `${session}.jsonl`);
  fs.writeFileSync(file, jsonl([{ type: 'summary', summary: 'x' }, ...entries]));
  return file;
}

/**
 * Builds a database with the tables and columns of T3 Code that `import` reads.
 * `threads`: [{ id, project, worktree, lineage, createdBy, createdAt, instance, model,
 * native, messages: [{ text, at, createdBy, idleCompaction }] }].
 */
function t3Database(file, { projects = [], threads = [] }) {
  const db = new sqlite.DatabaseSync(file);
  db.exec(`
    CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL, deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, driver TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE orchestration_v2_projection_messages (message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, role TEXT NOT NULL, streaming INTEGER NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL);
  `);
  for (const { id, title, root } of projects) db.prepare('INSERT INTO projection_projects VALUES (?, ?, ?, NULL)').run(id, title, root);
  let n = 0;
  for (const thread of threads) {
    const { id, project, worktree = null, lineage = {}, createdBy = 'user', createdAt = '2026-11-01T00:00:00.000Z', instance = 'claudeAgent', driver = 'claudeAgent', model = 'claude-opus-5-5', native = null, forkedFrom = null } = thread;
    const payload = { id, projectId: project, createdBy, providerInstanceId: instance, modelSelection: { instanceId: instance, model }, worktreePath: worktree, lineage: { parentThreadId: null, relationshipToParent: null, ...lineage }, forkedFrom, createdAt };
    db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?)').run(id, project, JSON.stringify(payload));
    const providerThread = `provider-thread:${id}`;
    db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?)').run(providerThread, id, driver, JSON.stringify({ id: providerThread, driver, appThreadId: id, nativeThreadRef: { driver, nativeId: native ?? `pending:${id}` } }));
    const run = `run:${id}`;
    db.prepare('INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?)').run(run, id, JSON.stringify({ id: run, threadId: id, providerInstanceId: instance, providerThreadId: providerThread, modelSelection: { instanceId: instance, model } }));
    for (const { text, at, createdBy: author = 'user', idleCompaction } of thread.messages ?? []) {
      const messageId = `message-${n++}`;
      const message = { createdBy: author, creationSource: author === 'user' ? 'web' : 'mcp', id: messageId, threadId: id, runId: run, role: 'user', text, attachments: [], ...(idleCompaction ? { idleCompaction: 'onReturn' } : {}) };
      db.prepare('INSERT INTO orchestration_v2_projection_messages VALUES (?, ?, ?, ?, 0, ?, ?)').run(messageId, id, run, 'user', at, JSON.stringify(message));
    }
  }
  db.close();
  return file;
}

const run = (env, cwd, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });

// ---------------------------------------------------------------------------
// Which directories belong to the repository

test('the matcher tells the checkout, worktrees and clones from other repositories', () => {
  const root = repository('my-app');
  const parent = path.dirname(root);
  const worktrees = path.join(parent, 'worktrees', 'my-app');
  git(root, 'worktree', 'add', '-q', path.join(worktrees, 'feature'), '-b', 'feature');
  git(root, 'worktree', 'add', '-q', path.join(worktrees, 'gone'), '-b', 'gone');
  fs.rmSync(path.join(worktrees, 'gone'), { recursive: true });
  const clone = path.join(parent, 'clone');
  git(parent, 'clone', '-q', root, clone);
  const other = repository('my-app-other');
  fs.mkdirSync(path.join(root, 'src'));

  const match = repositoryMatcher(repositoryIdentity(root));
  const strength = (dir) => match(dir).strength;
  assert.deepEqual(match(root), { strength: 'strong', reason: 'this checkout' });
  assert.equal(match(path.join(root, 'src')).reason, 'inside this checkout');
  assert.match(match(path.join(worktrees, 'feature')).reason, /^worktree of this repository \(git worktree list/);
  assert.equal(strength(path.join(worktrees, 'gone')), 'strong', 'a deleted worktree that git still lists');
  assert.equal(match(clone).reason, 'same root commit (another clone of this repository)');
  assert.deepEqual(match(other), { strength: null, reason: 'another git repository' });
  // Gone, never listed: only the layout of the path says it may be this repository's.
  assert.equal(strength(path.join(worktrees, 'pruned-long-ago', 'src')), 'weak');
  assert.equal(strength(path.join(parent, 'codex', 'worktrees', 'a1b2', 'my-app')), 'weak');
  assert.equal(strength(path.join(parent, 'worktrees', 'other-app', 'x')), null);
  assert.equal(strength(path.join(parent, 'elsewhere')), null);
  // A gone path that a host puts in another project is not this repository's.
  const hostPaths = new Map([[path.join(worktrees, 'theirs'), { mine: false, label: 'T3 Code puts it in another project ("Other")' }]]);
  const withHost = repositoryMatcher(repositoryIdentity(root), { hostPaths })(path.join(worktrees, 'theirs'));
  assert.equal(withHost.strength, null);
  assert.equal(withHost.contradicted, true);
  assert.match(withHost.reason, /^weak match .* contradicted: T3 Code puts it in another project/);
});

test('looksLikeWorktreeOf needs the repository name right after "worktrees", or one level below', () => {
  assert.equal(looksLikeWorktreeOf('/h/.t3/worktrees/app/t3-1234', ['app']), true);
  assert.equal(looksLikeWorktreeOf('/h/.codex/worktrees/9f3a/app/src', ['app']), true);
  assert.equal(looksLikeWorktreeOf('/h/.t3/worktrees/app', ['app']), false, 'the folder of all worktrees is not one');
  assert.equal(looksLikeWorktreeOf('/h/worktrees/apple/x', ['app']), false);
  assert.equal(looksLikeWorktreeOf('/h/code/app/x', ['app']), false);
});

// ---------------------------------------------------------------------------
// Claude Code transcripts in many folders

test('finds transcripts of the repository in every folder, and only those', async () => {
  const root = repository('my-app');
  const { env } = sources();
  const worktree = path.join(path.dirname(root), 'worktrees', 'my-app', 'task-1');
  git(root, 'worktree', 'add', '-q', worktree, '-b', 'task-1');
  const gone = path.join(path.dirname(root), 'worktrees', 'my-app', 'task-0');
  const other = repository('other-app');
  claudeTranscript(env, root, 'aaaaaaaa-1', [{ id: 'p1', text: 'in the checkout', at: '2026-11-20T10:00:00Z' }]);
  claudeTranscript(env, path.join(root, 'src'), 'bbbbbbbb-2', [{ id: 'p2', text: 'in a subdirectory', at: '2026-11-20T10:01:00Z' }]);
  claudeTranscript(env, worktree, 'cccccccc-3', [{ id: 'p3', text: 'in a worktree', at: '2026-11-20T10:02:00Z' }]);
  claudeTranscript(env, gone, 'dddddddd-4', [{ id: 'p4', text: 'in a deleted worktree', at: '2026-11-20T10:03:00Z' }]);
  claudeTranscript(env, other, 'eeeeeeee-5', [{ id: 'p5', text: 'in another repository', at: '2026-11-20T10:04:00Z' }]);

  const plan = await planImport(findProject(root), { sources: ['claude'], env });
  assert.deepEqual(plan.write.map((candidate) => candidate.prompt), ['in the checkout', 'in a subdirectory', 'in a worktree', 'in a deleted worktree']);
  const [report] = plan.reports;
  const reasons = Object.fromEntries(report.matched.map(({ label, reason, strength }) => [label.replace(/^.*-(my-app|src|task-\d)$/, '$1'), [strength, reason.split(' (')[0]]]));
  assert.deepEqual(reasons, {
    'my-app': ['strong', 'this checkout'],
    src: ['strong', 'inside this checkout'],
    'task-1': ['strong', 'worktree of this repository'],
    'task-0': ['weak', 'weak: the directory is gone, and its path looks like a worktree of my-app'],
  });
});

test('a prompt copied into a forked session, or already recorded by the hook, is written once', async () => {
  const root = repository();
  const { env } = sources();
  claudeTranscript(env, root, 'aaaaaaaa-1', [
    { id: 'p1', text: 'first', at: '2026-11-20T10:00:00Z' },
    { id: 'p2', text: 'second', at: '2026-11-20T10:05:00Z' },
  ]);
  // A fork copies p1 and p2, with their IDs, into a session that starts later.
  claudeTranscript(env, root, 'bbbbbbbb-2', [
    { id: 'p1', text: 'first', at: '2026-11-20T10:00:00Z' },
    { id: 'p2', text: 'second', at: '2026-11-20T10:05:00Z' },
    { id: 'p3', text: 'only in the fork', at: '2026-11-20T11:00:00Z' },
  ]);
  // The hook already wrote "second" in the first session, without the transcript's ID.
  fs.mkdirSync(path.join(root, 'prompts'));
  fs.writeFileSync(
    path.join(root, 'prompts', '2026-11-20-aaaaaaaa.jsonl'),
    jsonl([{ v: 1, timestamp: '2026-11-20T10:05:01Z', agent: 'claude-code', agent_version: null, model: null, session: 'aaaaaaaa-1', prompt: 'second' }]),
  );
  const plan = await planImport(findProject(root), { sources: ['claude'], env });
  assert.deepEqual(plan.write.map(({ session, prompt }) => [session, prompt]), [
    ['aaaaaaaa-1', 'first'],
    ['bbbbbbbb-2', 'only in the fork'],
  ]);
  assert.equal(plan.duplicates, 3);
});

// ---------------------------------------------------------------------------
// T3 Code

test('t3AgentSlug maps T3 drivers and provider instances to agent slugs', () => {
  assert.equal(t3AgentSlug('claudeAgent', 'claudeGemini'), 'claude-code');
  assert.equal(t3AgentSlug('acpRegistry', 'geminiCli'), 'gemini-cli');
  assert.equal(t3AgentSlug(undefined, 'codex'), 'codex');
  assert.equal(t3AgentSlug(undefined, 'claudeGpt'), 'claude-code');
  assert.equal(t3AgentSlug(undefined, 'myCustomAgent'), 'my-custom-agent');
  assert.equal(t3AgentSlug(undefined, undefined), 'unknown');
});

test("reads the person's messages of the repository's T3 threads", { skip }, () => {
  const root = repository();
  const { home } = sources();
  const gone = path.join(path.dirname(root), 'worktrees', 'my-app', 't3-0001');
  const file = t3Database(path.join(home, 't3.sqlite'), {
    projects: [
      { id: 'p-mine', title: 'My app', root },
      { id: 'p-other', title: 'Other', root: path.join(home, 'elsewhere') },
    ],
    threads: [
      {
        id: 'thread-1',
        project: 'p-mine',
        worktree: gone,
        native: 'claude-session-1',
        messages: [
          { text: 'Add a login page ![image.png](t3-context://v1/image/image_1)', at: '2026-11-20T10:00:00.000Z' },
          { text: 'Note from another session: rebased', at: '2026-11-20T10:01:00.000Z', createdBy: 'agent' },
          { text: '/compact', at: '2026-11-20T10:02:00.000Z', idleCompaction: true },
        ],
      },
      { id: 'thread-codex', project: 'p-mine', instance: 'codex', driver: 'codex', model: 'gpt-5.5', native: 'codex-thread', messages: [{ text: 'typed in Codex', at: '2026-11-20T10:03:00.000Z' }] },
      { id: 'thread-sub', project: 'p-mine', lineage: { relationshipToParent: 'subagent' }, createdBy: 'agent', native: 'sub-session', messages: [{ text: 'do the work', at: '2026-11-20T10:04:00.000Z', createdBy: 'user' }] },
      { id: 'thread-mcp', project: 'p-mine', createdBy: 'agent', messages: [{ text: 'brief', at: '2026-11-20T10:05:00.000Z', createdBy: 'agent' }, { text: 'typed in a thread an agent opened', at: '2026-11-20T10:06:00.000Z' }] },
      { id: 'thread-fork', project: 'p-mine', lineage: { relationshipToParent: 'fork' }, createdAt: '2026-11-20T10:30:00.000Z', messages: [{ text: 'copied from the parent', at: '2026-11-20T10:00:30.000Z' }, { text: 'typed in the fork', at: '2026-11-20T10:31:00.000Z' }] },
      { id: 'thread-other', project: 'p-other', worktree: path.join(path.dirname(root), 'worktrees', 'my-app', 't3-other'), messages: [{ text: 'not this repository', at: '2026-11-20T10:07:00.000Z' }] },
    ],
  });
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  const t3 = readT3(db, repositoryMatcher(repositoryIdentity(root)));
  db.close();
  assert.deepEqual(t3.projects.map(({ title }) => title), ['My app']);
  const prompts = t3.prompts.map(({ agent, session, model, prompt, automated, extensions }) => ({ agent, session, model, prompt, automated, thread: extensions.x_thread }));
  assert.deepEqual(prompts, [
    { agent: 'claude-code', session: 'claude-session-1', model: 'claude-opus-5-5', prompt: 'Add a login page [image]', automated: null, thread: 'thread-1' },
    { agent: 'claude-code', session: 'claude-session-1', model: 'claude-opus-5-5', prompt: 'Note from another session: rebased', automated: 'written by an agent, according to T3 Code', thread: 'thread-1' },
    { agent: 'claude-code', session: 'claude-session-1', model: 'claude-opus-5-5', prompt: '/compact', automated: 'sent by T3 Code when the person came back to an idle thread', thread: 'thread-1' },
    { agent: 'codex', session: 'codex-thread', model: 'gpt-5.5', prompt: 'typed in Codex', automated: null, thread: 'thread-codex' },
    { agent: 'claude-code', session: 'sub-session', model: 'claude-opus-5-5', prompt: 'do the work', automated: "a sub-agent's thread in T3 Code", thread: 'thread-sub' },
    { agent: 'claude-code', session: 'thread-mcp', model: 'claude-opus-5-5', prompt: 'brief', automated: 'written by an agent, according to T3 Code', thread: 'thread-mcp' },
    { agent: 'claude-code', session: 'thread-mcp', model: 'claude-opus-5-5', prompt: 'typed in a thread an agent opened', automated: null, thread: 'thread-mcp' },
    { agent: 'claude-code', session: 'thread-fork', model: 'claude-opus-5-5', prompt: 'typed in the fork', automated: null, thread: 'thread-fork' },
  ]);
  // T3 knows the deleted worktree is this repository's, and that the other one is not.
  const match = repositoryMatcher(repositoryIdentity(root), { hostPaths: t3.hostPaths });
  assert.deepEqual(match(gone), { strength: 'strong', reason: 'T3 Code worktree of project "My app"' });
  assert.equal(match(path.join(path.dirname(root), 'worktrees', 'my-app', 't3-other')).contradicted, true);
  assert.equal(t3.sessions.get('sub-session').automated, "a sub-agent's thread in T3 Code");
});

test('a prompt in both a transcript and T3 is written once, and T3 says who wrote it', { skip }, async () => {
  const root = repository();
  const { home, env } = sources();
  const gone = path.join(home, 'gone-worktree');
  const session = '5f0c2a7e-1b9d-4e3a-8c6f-2d4b7a9e1c30';
  claudeTranscript(env, gone, session, [
    { id: 'p1', text: 'Add a login page\n\n[Attached image "image.png" is saved at: /Users/jane/.t3/userdata/attachments/a.png]', at: '2026-11-20T10:00:05Z' },
    // Queued behind a long turn: the agent starts it twenty minutes after T3 stored it.
    { id: 'p2', text: 'Please review the diff', at: '2026-11-20T10:21:00Z' },
    { id: 'p3', text: 'Continue where you left off.', at: '2026-11-20T10:30:00Z' },
  ]);
  claudeTranscript(env, gone, 'sub-session', [{ id: 's1', text: 'Look for dead code', at: '2026-11-20T10:02:00Z' }]);
  env.OPEN_PROMPTS_T3_DB = t3Database(path.join(home, 't3.sqlite'), {
    projects: [{ id: 'p-mine', title: 'My app', root }],
    threads: [
      {
        id: 'thread-1',
        project: 'p-mine',
        worktree: gone,
        native: session,
        messages: [
          { text: 'Add a login page ![image.png](t3-context://v1/image/image_1)', at: '2026-11-20T10:00:00.000Z' },
          { text: 'Please review the diff', at: '2026-11-20T10:01:00.000Z', createdBy: 'agent' },
          { text: 'Continue where you left off.', at: '2026-11-20T10:29:59.000Z' },
          { text: 'only T3 kept this one', at: '2026-11-20T10:40:00.000Z' },
        ],
      },
      { id: 'thread-sub', project: 'p-mine', lineage: { relationshipToParent: 'subagent' }, createdBy: 'agent', native: 'sub-session', messages: [] },
    ],
  });
  const plan = await planImport(findProject(root), { env });
  const written = plan.write.map(({ source, prompt, extensions }) => [source, prompt, extensions?.x_thread]);
  assert.deepEqual(written, [
    ['claude', 'Add a login page\n\n[image]', 'thread-1'],
    ['claude', 'Continue where you left off.', 'thread-1'],
    ['t3', 'only T3 kept this one', 'thread-1'],
  ]);
  assert.deepEqual(plan.automated.map(({ source, prompt }) => [source, prompt]).sort(), [
    ['claude', 'Look for dead code'],
    ['claude', 'Please review the diff'],
  ]);
  const claudeReport = plan.reports.find((report) => report.source === 'claude');
  assert.deepEqual(claudeReport.matched.map(({ reason }) => reason), ['T3 Code worktree of project "My app"']);
  // Without --source t3, T3 still says who wrote what, but what only T3 has is left alone.
  const claudeOnly = await planImport(findProject(root), { env, sources: ['claude'] });
  assert.deepEqual(claudeOnly.write.map(({ prompt }) => prompt), ['Add a login page\n\n[image]', 'Continue where you left off.']);
});

test('reconcile pairs the copies closest in time, so a prompt typed twice stays twice', () => {
  const claude = (id, at) => ({ source: 'claude', agent: 'claude-code', session: 's1', id, timestamp: at, prompt: 'go', automated: null });
  const t3 = (id, at) => ({ source: 't3', agent: 'claude-code', session: 's1', knownSession: true, id, timestamp: at, prompt: 'go', typed: true, automated: null, extensions: { x_host: 't3', x_thread: 'th' } });
  const { write } = reconcile([claude('c1', '2026-11-20T10:00:01Z'), claude('c2', '2026-11-20T11:00:01Z'), t3('m1', '2026-11-20T10:00:00Z'), t3('m2', '2026-11-20T11:00:00Z')]);
  assert.deepEqual(write.map(({ id, extensions }) => [id, extensions?.x_thread]), [
    ['c1', 'th'],
    ['c2', 'th'],
  ]);
});

// ---------------------------------------------------------------------------
// Codex

/** Writes a Codex rollout file. */
function rollout(env, { id, cwd, extra = {}, lines, firstAt = '2026-11-20T10:00:00.000Z' }) {
  const dir = path.join(env.CODEX_HOME, 'sessions', '2026', '11', '20');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-11-20T10-00-00-${id}.jsonl`);
  fs.writeFileSync(file, jsonl([{ timestamp: firstAt, type: 'session_meta', payload: { id, timestamp: firstAt, cwd, originator: 'codex_cli_rs', cli_version: '0.130.0', source: 'cli', ...extra } }, ...lines]));
  return file;
}
const turn = (model, at) => [
  { timestamp: at, type: 'event_msg', payload: { type: 'task_started', turn_id: at } },
  { timestamp: at, type: 'turn_context', payload: { turn_id: at, model } },
];
const typed = (message, at) => ({ timestamp: at, type: 'event_msg', payload: { type: 'user_message', message, images: [] } });

test('reads Codex rollouts: the model of each turn, and only what the person typed', async () => {
  const root = repository();
  const { env } = sources();
  rollout(env, {
    id: '019f0000-0000-7000-8000-000000000001',
    cwd: root,
    lines: [
      ...turn('gpt-5.5', '2026-11-20T10:00:10.000Z'),
      typed('Add a test', '2026-11-20T10:00:11.000Z'),
      typed('and run it', '2026-11-20T10:00:40.000Z'),
      ...turn('gpt-5.5-codex', '2026-11-20T10:05:00.000Z'),
      typed('\n# Files mentioned by the user:\n\n## shot.png: /var/folders/x/shot.png\n\n## My request for Codex:\nwhy is this red?\n', '2026-11-20T10:05:01.000Z'),
    ],
  });
  rollout(env, { id: '019f0000-0000-7000-8000-000000000002', cwd: root, extra: { source: { subagent: { thread_spawn: { depth: 1 } } }, agent_role: 'worker' }, lines: [typed('brief for a sub-agent', '2026-11-20T10:01:00.000Z')] });
  rollout(env, {
    id: '019f0000-0000-7000-8000-000000000003',
    cwd: root,
    extra: { forked_from_id: '019f0000-0000-7000-8000-000000000001' },
    firstAt: '2026-11-20T11:00:00.000Z',
    lines: [typed('Add a test', '2026-11-20T11:00:00.004Z'), ...turn('gpt-5.5', '2026-11-20T11:02:00.000Z'), typed('typed in the fork', '2026-11-20T11:02:01.000Z')],
  });
  rollout(env, { id: '019f0000-0000-7000-8000-000000000004', cwd: path.join(path.dirname(root), 'elsewhere'), lines: [typed('not here', '2026-11-20T10:00:00.000Z')] });
  fs.writeFileSync(path.join(env.CODEX_HOME, 'external_agent_session_imports.json'), JSON.stringify({ records: [{ imported_thread_id: '019f0000-0000-7000-8000-000000000005' }] }));
  rollout(env, { id: '019f0000-0000-7000-8000-000000000005', cwd: root, lines: [typed('imported from Claude Code', '2026-11-20T10:00:00.000Z')] });

  const plan = await planImport(findProject(root), { sources: ['codex'], env });
  assert.deepEqual(
    plan.write.map(({ prompt, model, agentVersion }) => [prompt, model, agentVersion]),
    [
      ['Add a test', 'gpt-5.5', '0.130.0'],
      ['and run it', 'gpt-5.5', '0.130.0'],
      ['why is this red? [image]', 'gpt-5.5-codex', '0.130.0'],
      ['typed in the fork', 'gpt-5.5', '0.130.0'],
    ],
  );
  const reasons = plan.reports[0].rejected.map(({ reason }) => reason).sort();
  assert.deepEqual(reasons, ['skipped: Codex imported it from another agent', "skipped: a Codex sub-agent's session"]);
});

test('cleanCodexPrompt keeps the request and drops the context the Codex app adds', () => {
  assert.equal(cleanCodexPrompt('\n# In app browser:\n- url: http://localhost:3000\n\n## My request for Codex:\nmake the header blue\n'), 'make the header blue');
  assert.equal(cleanCodexPrompt('[Image #1] what is this?'), '[image] what is this?');
  assert.equal(cleanCodexPrompt('# Heading: not context\nplain text'), '# Heading: not context\nplain text');
  assert.deepEqual(rolloutPrompts('/nonexistent/rollout.jsonl'), []);
});

test('the Codex hook removes the context of the Codex app too', async () => {
  const { root, env } = optedInRepo();
  const prompt = '\n# Selected text:\n\n## Selection 1\nconst a = 1;\n\n## My request for Codex:\nrename this\n';
  const result = await codexHook({ hook_event_name: 'UserPromptSubmit', turn_id: 't', session_id: 'codex-session', cwd: root, prompt, model: 'gpt-5.5' }, { env });
  assert.equal(readJsonl(result.file)[0].prompt, 'rename this');
});

// ---------------------------------------------------------------------------
// Gemini CLI

test('reads Gemini CLI chats, by the path Gemini CLI wrote down or by its hash', async () => {
  const root = repository();
  const { env } = sources();
  const tmp = path.join(env.GEMINI_CLI_HOME, '.gemini', 'tmp');
  fs.mkdirSync(path.join(tmp, 'my-app', 'chats'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'my-app', '.project_root'), root);
  fs.writeFileSync(
    path.join(tmp, 'my-app', 'chats', 'session-2026-11-20T10-00-aaaa1111.jsonl'),
    jsonl([
      { sessionId: 'aaaa1111-0000', projectHash: projectHash(root), startTime: '2026-11-20T10:00:00.000Z', kind: 'main' },
      { id: 'm0', timestamp: '2026-11-20T10:00:00.000Z', type: 'user', content: [{ text: '<session_context>\nThis is the Gemini CLI.\n</session_context>' }] },
      { id: 'm1', timestamp: '2026-11-20T10:00:01.000Z', type: 'user', content: [{ text: 'Explain @src/app.ts\n--- Content from referenced files ---\nconst x = 1;\n--- End of content ---' }] },
      { id: 'm2', timestamp: '2026-11-20T10:00:05.000Z', type: 'gemini', content: 'It sets x.', model: 'gemini-4-pro' },
      { id: 'm3', timestamp: '2026-11-20T10:00:06.000Z', type: 'user', content: [{ functionResponse: { name: 'read_file' } }] },
      { $set: { lastUpdated: '2026-11-20T10:00:06.000Z' } },
      // T3 Code reloads the session and sends the first prompt again.
      { id: 'm4', timestamp: '2026-11-20T10:10:00.000Z', type: 'user', content: [{ text: '<session_context>\nThis is the Gemini CLI.\n</session_context>' }] },
      { id: 'm5', timestamp: '2026-11-20T10:10:01.000Z', type: 'user', content: [{ text: 'Explain @src/app.ts\n--- Content from referenced files ---\nconst x = 1;\n--- End of content ---' }] },
      { id: 'm6', timestamp: '2026-11-20T10:10:02.000Z', type: 'user', content: [{ text: '<t3_code_instructions>\nBe brief.\n<user_request>\nnow add a test\n</user_request>\n</t3_code_instructions>' }] },
      { id: 'm7', timestamp: '2026-11-20T10:10:05.000Z', type: 'gemini', content: 'Done.', model: 'gemini-4-flash' },
    ]),
  );
  // An older Gemini CLI: the directory is the hash of the path, and the chat is one JSON object.
  const hashed = path.join(tmp, projectHash(root), 'chats');
  fs.mkdirSync(hashed, { recursive: true });
  fs.writeFileSync(
    path.join(hashed, 'session-2026-11-19T09-00-bbbb2222.json'),
    JSON.stringify({ sessionId: 'bbbb2222-0000', projectHash: projectHash(root), messages: [{ id: 'o1', timestamp: '2026-11-19T09:00:00.000Z', type: 'user', content: 'an older session' }, { id: 'o2', type: 'gemini', model: 'gemini-3-pro', content: 'ok' }] }),
  );
  const plan = await planImport(findProject(root), { sources: ['gemini'], env });
  assert.deepEqual(
    plan.write.map(({ session, prompt, model, id }) => [session, prompt, model, id]),
    [
      ['bbbb2222-0000', 'an older session', 'gemini-3-pro', 'o1'],
      ['aaaa1111-0000', 'Explain @src/app.ts', 'gemini-4-pro', 'm1'],
      ['aaaa1111-0000', 'now add a test', 'gemini-4-flash', 'm6'],
    ],
  );
  assert.deepEqual(chatPrompts('/nonexistent/session.json'), []);
});

// ---------------------------------------------------------------------------
// The command

test('import --all --dry-run lists the folders it read and why, and writes nothing', () => {
  const root = repository();
  const { env } = sources();
  const gone = path.join(path.dirname(root), 'worktrees', 'my-app', 'old-task');
  claudeTranscript(env, root, 'aaaaaaaa-1', [{ id: 'p1', text: 'in the checkout', at: '2026-11-20T10:00:00Z' }]);
  claudeTranscript(env, gone, 'bbbbbbbb-2', [{ id: 'p2', text: 'in a deleted worktree', at: '2026-11-20T10:01:00Z' }]);
  const result = run(env, root, 'import', '--all', '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Claude Code: 2 sessions in 2 folders of /m);
  assert.match(result.stdout, /^ {2}-\S+-my-app \(1 session\): this checkout$/m);
  assert.match(result.stdout, /^ {2}-\S+-old-task \(1 session\): weak: the directory is gone, and its path looks like a worktree of my-app$/m);
  assert.match(result.stdout, /^Codex: no sessions \(/m);
  assert.match(result.stdout, /^T3 Code: not found \(/m);
  assert.match(result.stdout, /  in a deleted worktree/);
  assert.match(result.stdout, /^2 prompts would be imported\.$/m);
  assert.equal(fs.existsSync(path.join(root, 'prompts')), false);
  // The repository's history starts long before the oldest session.
  assert.match(result.stdout, /^Note: The history of this repository starts on 2026-01-05, but the oldest session found is from 2026-11-20\./m);
});

test('import <session> finds a session in any folder of the repository, and says where another one is', () => {
  const root = repository();
  const { env } = sources();
  const worktree = path.join(path.dirname(root), 'wt');
  git(root, 'worktree', 'add', '-q', worktree, '-b', 'wt');
  claudeTranscript(env, worktree, 'cccccccc-3', [{ id: 'p3', text: 'in a worktree', at: '2026-11-20T10:02:00Z' }]);
  const elsewhere = claudeTranscript(env, path.join(path.dirname(root), 'unrelated'), 'dddddddd-4', [{ id: 'p4', text: 'unrelated', at: '2026-11-20T10:03:00Z' }]);

  const imported = run(env, root, 'import', 'cccccccc-3');
  assert.equal(imported.status, 0, imported.stderr);
  assert.match(imported.stdout, /^1 prompt imported\.$/m);
  assert.doesNotMatch(imported.stdout, /Note: The history of this repository/, 'the history note is for --all only');
  assert.equal(readJsonl(path.join(root, 'prompts', '2026-11-20-cccccccc.jsonl'))[0].prompt, 'in a worktree');

  const refused = run(env, root, 'import', 'dddddddd-4');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /which does not belong to this repository\. If it does, import the file/);
  const file = run(env, root, 'import', elsewhere);
  assert.equal(file.status, 0, file.stderr);
  assert.match(file.stdout, /^1 prompt imported\.$/m);
});

test('--source picks the sources, and an unknown one is an error', () => {
  assert.deepEqual(parseSources([]), ['claude', 't3', 'codex', 'gemini']);
  assert.deepEqual(parseSources(['claude,t3', 'codex', 'claude']), ['claude', 't3', 'codex']);
  assert.throws(() => parseSources(['cursor']), /Unknown source "cursor"\. Sources: claude, t3, codex, gemini\./);
  const root = repository();
  const { env } = sources();
  const result = run(env, root, 'import', '--all', '--source', 'codex', '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Claude Code:/);
  assert.match(result.stdout, /^Codex: /m);
  assert.match(result.stdout, /--source claude,t3,gemini/);
  assert.equal(run(env, root, 'import', '--all', '--source', 'nope').status, 1);
});

// ---------------------------------------------------------------------------
// Claude Code's retention

test('install warns when Claude Code deletes transcripts soon, and --keep-transcripts changes it', () => {
  const { env } = sources();
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const settings = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ model: 'opus' }));
  assert.deepEqual(claudeRetention(env), { days: 30, set: false, file: settings });
  assert.match(claudeRetentionWarning(env), /^Claude Code deletes transcripts after 30 days \(.*has no cleanupPeriodDays, so the default applies\)\..*--keep-transcripts/);

  const cwd = realTemp('open-prompts-cwd-');
  const warned = run(env, cwd, 'install', '--agent', 'claude-code');
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stdout, /^Note: Claude Code deletes transcripts after 30 days/m);
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).cleanupPeriodDays, undefined, 'only the flag changes the setting');

  const kept = run(env, cwd, 'install', '--agent', 'claude-code', '--keep-transcripts');
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stdout, /transcripts are kept for 365 days/);
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).cleanupPeriodDays, 365);
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).model, 'opus');
  assert.ok(fs.existsSync(`${settings}.open-prompts.bak`));
  assert.equal(claudeRetentionWarning(env), null);

  assert.equal(run(env, cwd, 'install', '--agent', 'claude-code', '--keep-transcripts', '1000').status, 0);
  assert.equal(claudeRetention(env).days, 1000);
  assert.equal(run(env, cwd, 'install', '--agent', 'claude-code', '--keep-transcripts', 'forever').status, 1);
  assert.throws(() => setClaudeRetention(0, env), /whole number of days/);
});

test('a record found by ID does not also stand for another prompt with the same text', () => {
  const candidate = (id, at) => ({ source: 'claude', agent: 'claude-code', session: 's1', id, timestamp: at, prompt: 'go', automated: null });
  const existing = [{ v: 1, id: 'c2', timestamp: '2026-11-20T10:30:00Z', agent: 'claude-code', session: 's1', prompt: 'go' }];
  const { write, duplicates } = reconcile([candidate('c1', '2026-11-20T10:00:00Z'), candidate('c2', '2026-11-20T10:30:00Z')], { existing });
  assert.deepEqual(write.map(({ id }) => id), ['c1']);
  assert.equal(duplicates, 1);
});

test('a record without an ID that a person edited is not written again in its first form', () => {
  const candidate = { source: 'codex', agent: 'codex', session: 'codex-1', timestamp: '2026-11-20T10:00:00.250Z', prompt: 'deploy to db.internal.corp with key hunter', automated: null };
  const edited = { v: 1, timestamp: '2026-11-20T10:00:00.250Z', agent: 'codex', session: 'codex-1', prompt: 'deploy to <host> with key hunter' };
  assert.deepEqual(reconcile([candidate], { existing: [edited] }), { write: [], duplicates: 1, automated: [] });
  // Another session, or another time, is another prompt.
  assert.equal(reconcile([{ ...candidate, session: 'codex-2' }], { existing: [edited] }).write.length, 1);
  assert.equal(reconcile([{ ...candidate, timestamp: '2026-11-20T10:00:05Z' }], { existing: [edited] }).write.length, 1);
});
