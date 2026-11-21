// Live detection under T3 Code, against a small database built like T3's.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { handle as claudeHook } from '../src/agents/claude-code.mjs';
import * as codex from '../src/agents/codex.mjs';
import { loadSqlite, matchMessage, t3Origin } from '../src/t3.mjs';
import { optedInRepo, readJsonl, tempDir } from './helpers.mjs';

const sqlite = await loadSqlite();
const skip = sqlite ? false : 'node:sqlite is not available in this Node.js';
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'open-prompts');
const NOW = new Date('2026-11-20T15:48:02.123Z');
const SESSION = '5f0c2a7e-1b9d-4e3a-8c6f-2d4b7a9e1c30';

/**
 * Builds a database with the tables and columns of T3 Code that the hooks read.
 * `threads` maps a thread ID to { lineage, natives, messages: [{ text, createdBy }] }, oldest first.
 */
function t3Database(threads) {
  const file = path.join(tempDir('open-prompts-t3-'), 'statev2.sqlite');
  const db = new sqlite.DatabaseSync(file);
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE orchestration_v2_projection_messages (message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, streaming INTEGER NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL);
    PRAGMA journal_mode = WAL;
  `);
  let n = 0;
  for (const [id, { lineage = {}, natives = [SESSION], messages = [] }] of Object.entries(threads)) {
    db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?)').run(id, 'project', JSON.stringify({ id, createdBy: 'user', lineage: { parentThreadId: null, relationshipToParent: null, ...lineage } }));
    for (const native of natives) {
      db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?)').run(`pt-${n++}`, id, JSON.stringify({ nativeThreadRef: { driver: 'claudeAgent', nativeId: native } }));
    }
    for (const { text, createdBy = 'user', role = 'user' } of messages) {
      const created = new Date(Date.UTC(2026, 10, 20, 15, 0, n++)).toISOString();
      const payload = { createdBy, creationSource: createdBy === 'user' ? 'web' : 'mcp', id: `m-${n}`, threadId: id, role, text, attachments: [] };
      db.prepare('INSERT INTO orchestration_v2_projection_messages VALUES (?, ?, ?, 0, ?, ?)').run(`m-${n}`, id, role, created, JSON.stringify(payload));
    }
  }
  db.close();
  return file;
}

const submit = (root, env, prompt, session = SESSION) =>
  claudeHook({ hook_event_name: 'UserPromptSubmit', session_id: session, cwd: root, transcript_path: '', prompt }, { env, now: NOW, waitMs: 0 });

test('matchMessage compares cleaned text, and the start of long prompts', () => {
  const messages = [{ text: 'newest', createdBy: 'agent' }, { text: 'look ![image.png](t3-context://v1/image/image_1) here', createdBy: 'user' }];
  assert.equal(matchMessage('look [Image: image.png; ref=image_1] here\n\n[Attached image "image.png" is saved at: /tmp/a.png]', messages), messages[1]);
  assert.equal(matchMessage('newest', messages), messages[0]);
  assert.equal(matchMessage('something else', messages), null);
  const long = 'x'.repeat(300);
  assert.equal(matchMessage(`${long} plus a tail the host added`, [{ text: long }])?.text, long);
  assert.equal(matchMessage('short', [{ text: 'short but longer' }]), null);
});

test('records what the person typed, with the T3 thread', { skip }, async () => {
  const { root, env } = optedInRepo();
  const db = t3Database({ 'thread-1': { messages: [{ text: 'earlier' }, { text: 'Add a login page ![image.png](t3-context://v1/image/image_1)' }] } });
  const result = await submit(root, { ...env, T3CODE_THREAD_ID: 'thread-1', OPEN_PROMPTS_T3_DB: db }, `Add a login page [Image: image.png; ref=image_1]\n\n${'[Attached image "image.png" is saved at: /Users/jane/.t3/userdata/attachments/a.png]'}`);
  assert.equal(result.action, 'recorded');
  const [record] = readJsonl(result.file);
  assert.equal(record.prompt, 'Add a login page [image]');
  assert.deepEqual(Object.keys(record).slice(-3), ['prompt', 'x_host', 'x_thread']);
  assert.equal(record.x_host, 't3');
  assert.equal(record.x_thread, 'thread-1');
});

test('skips a message an agent wrote, whatever it looks like', { skip }, async () => {
  const { root, env } = optedInRepo();
  const db = t3Database({ 'thread-1': { messages: [{ text: 'Please review the diff and fix the tests', createdBy: 'agent' }, { text: 'thanks' }] } });
  const t3Env = { ...env, T3CODE_THREAD_ID: 'thread-1', OPEN_PROMPTS_T3_DB: db };
  assert.deepEqual(await submit(root, t3Env, 'Please review the diff and fix the tests'), { action: 'ignored', reason: 'written by an agent, according to T3 Code' });
  assert.equal((await submit(root, t3Env, 'thanks')).action, 'recorded');
});

test("trusts T3 over the text rules when the person typed something that looks like an agent's", { skip }, async () => {
  const { root, env } = optedInRepo();
  const db = t3Database({ 'thread-1': { messages: [{ text: 'Continue where you left off.' }] } });
  const result = await submit(root, { ...env, T3CODE_THREAD_ID: 'thread-1', OPEN_PROMPTS_T3_DB: db }, 'Continue where you left off.');
  assert.equal(result.action, 'recorded');
});

test("skips every prompt in a sub-agent's thread", { skip }, async () => {
  const { root, env } = optedInRepo();
  const db = t3Database({ child: { lineage: { parentThreadId: 'parent', relationshipToParent: 'subagent' }, messages: [{ text: 'do the work', createdBy: 'user' }] } });
  assert.deepEqual(await submit(root, { ...env, T3CODE_THREAD_ID: 'child', OPEN_PROMPTS_T3_DB: db }, 'do the work'), { action: 'ignored', reason: "a sub-agent's thread in T3 Code" });
});

test('unwraps a context handoff before matching it', { skip }, async () => {
  const { root, env } = optedInRepo();
  const db = t3Database({ 'thread-1': { messages: [{ text: 'ship it', createdBy: 'agent' }] } });
  const result = await submit(root, { ...env, T3CODE_THREAD_ID: 'thread-1', OPEN_PROMPTS_T3_DB: db }, 'Context handoff (delta_since_target_last_seen):\nsummary\n\nUser message:\nship it');
  assert.equal(result.action, 'ignored');
});

test('falls back to the text rules when the message is not found', { skip }, async () => {
  const { root, env } = optedInRepo();
  const db = t3Database({ 'thread-1': { messages: [{ text: 'something older' }] } });
  const t3Env = { ...env, T3CODE_THREAD_ID: 'thread-1', OPEN_PROMPTS_T3_DB: db };
  const automated = await submit(root, t3Env, 'Note from another session (no reply needed): main moved.');
  assert.equal(automated.action, 'ignored');
  assert.match(automated.t3, /no matching message/);
  const typed = await submit(root, t3Env, 'a prompt T3 has not stored');
  assert.equal(typed.action, 'recorded');
  assert.equal(readJsonl(typed.file)[0].x_thread, 'thread-1');
});

test('a session T3 does not run for the thread gets neither the fields nor the verdict', { skip }, async () => {
  const { root, env } = optedInRepo();
  const db = t3Database({ 'thread-1': { natives: ['another-session'], messages: [{ text: 'nested prompt', createdBy: 'agent' }] } });
  const result = await submit(root, { ...env, T3CODE_THREAD_ID: 'thread-1', OPEN_PROMPTS_T3_DB: db }, 'nested prompt', 'nested-session');
  assert.equal(result.action, 'recorded');
  assert.equal('x_host' in readJsonl(result.file)[0], false);
  const pending = t3Database({ 'thread-1': { natives: ['pending:abc'], messages: [{ text: 'first prompt', createdBy: 'agent' }] } });
  assert.equal((await submit(root, { ...env, T3CODE_THREAD_ID: 'thread-1', OPEN_PROMPTS_T3_DB: pending }, 'first prompt', 'new-session')).action, 'ignored', 'a native ID T3 has not learned yet does not count against the session');
});

test('records with the T3 fields when the database cannot be read', async () => {
  const { root, env } = optedInRepo();
  const result = await submit(root, { ...env, T3CODE_THREAD_ID: 'thread-1', OPEN_PROMPTS_T3_DB: path.join(tempDir(), 'missing.sqlite') }, 'Add a login page');
  assert.equal(result.action, 'recorded');
  assert.ok(result.t3, 'the reason is kept for the debug log');
  const [record] = readJsonl(result.file);
  assert.deepEqual([record.x_host, record.x_thread], ['t3', 'thread-1']);
  assert.equal((await submit(root, { ...env, T3CODE_THREAD_ID: 'thread-1', OPEN_PROMPTS_T3_DB: path.join(tempDir(), 'missing.sqlite') }, 'Delegated task node:delegated-task:x done')).action, 'ignored');
});

test('outside T3 there is nothing to ask', async () => {
  assert.equal(await t3Origin('hello', { env: {} }), null);
  const { root, env } = optedInRepo();
  const result = await submit(root, env, 'hello');
  assert.equal('x_host' in readJsonl(result.file)[0], false);
});

test('a database that is not T3 is handled like an unreadable one', { skip }, async () => {
  const file = path.join(tempDir(), 'other.sqlite');
  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE t (x)');
  db.close();
  const origin = await t3Origin('hello', { env: { T3CODE_THREAD_ID: 'thread-1', OPEN_PROMPTS_T3_DB: file } });
  assert.equal(origin.automated, null);
  assert.match(origin.note, /could not be read/);
});

test('the Codex hook asks T3 too', { skip }, async () => {
  const { root, env } = optedInRepo();
  const db = t3Database({ 'thread-1': { natives: ['codex-thread'], messages: [{ text: 'from the orchestrator', createdBy: 'agent' }, { text: 'typed here' }] } });
  const t3Env = { ...env, T3CODE_THREAD_ID: 'thread-1', OPEN_PROMPTS_T3_DB: db };
  const event = (prompt) => ({ hook_event_name: 'UserPromptSubmit', turn_id: 't', session_id: 'codex-thread', cwd: root, prompt, model: 'gpt-5.5' });
  assert.equal((await codex.handle(event('typed here'), { env: t3Env, now: NOW })).action, 'recorded');
  assert.equal((await codex.handle(event('from the orchestrator'), { env: t3Env, now: NOW })).action, 'ignored');
});

test('the hook prints nothing and exits 0 while it reads the database', { skip }, () => {
  const { root, state } = optedInRepo();
  const db = t3Database({ 'thread-1': { messages: [{ text: 'hello there' }] } });
  const env = { ...process.env, OPEN_PROMPTS_STATE_DIR: state, OPEN_PROMPTS_WAIT_MS: '0', T3CODE_THREAD_ID: 'thread-1', OPEN_PROMPTS_T3_DB: db };
  const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: SESSION, cwd: root, transcript_path: '', prompt: 'hello there' });
  const run = spawnSync(process.execPath, [BIN, 'hook', '--agent', 'claude-code'], { cwd: root, env, input, encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, '', 'no ExperimentalWarning either');
  assert.equal(readJsonl(path.join(root, 'prompts', fs.readdirSync(path.join(root, 'prompts'))[0]))[0].x_thread, 'thread-1');
});
