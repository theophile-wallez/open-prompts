import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { cleanPrompt, detectVersion, extractPrompts, handle as handleHook, importTranscript, replyModel } from '../src/agents/claude-code.mjs';
import { findProject } from '../src/project.mjs';
import { optedInRepo, readJsonl, tempDir } from './helpers.mjs';

const SESSION = '234908e6-56a5-49e3-b055-a161f39d736f';
const NOW = new Date('2026-11-20T15:48:02.123Z');
const event = (root, fields) => ({ session_id: SESSION, cwd: root, transcript_path: '', ...fields });

test('records a prompt with the model from SessionStart', async () => {
  const { root, env, promptsDir } = optedInRepo();
  await handleHook(event(root, { hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5' }), { env });
  const result = await handleHook(event(root, { hook_event_name: 'UserPromptSubmit', prompt: 'Add a login page', prompt_id: 'p1' }), { env, now: NOW });

  assert.equal(result.action, 'recorded');
  assert.equal(result.file, path.join(promptsDir, '2026-11-20-234908e6.jsonl'));
  assert.deepEqual(readJsonl(result.file), [
    { v: 1, id: 'p1', timestamp: '2026-11-20T15:48:02.123Z', agent: 'claude-code', agent_version: '2.1.328', model: 'claude-opus-5-5', session: SESSION, prompt: 'Add a login page' },
  ]);
});

test('follows model switches', async () => {
  const { root, env } = optedInRepo();
  await handleHook(event(root, { hook_event_name: 'SessionStart', model: 'claude-opus-5-5' }), { env });
  await handleHook(event(root, { hook_event_name: 'PostModelSwitch', from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5' }), { env });
  const { file } = await handleHook(event(root, { hook_event_name: 'UserPromptSubmit', prompt: 'next' }), { env, now: NOW });
  assert.equal(readJsonl(file)[0].model, 'claude-sonnet-5-5');
});

test('falls back to the transcript for the model and version', async () => {
  const { root, env } = optedInRepo();
  const transcript = path.join(tempDir(), 't.jsonl');
  fs.writeFileSync(
    transcript,
    [
      { type: 'user', version: '2.1.300', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', version: '2.1.300', message: { model: 'claude-haiku-5-5' } },
      { type: 'assistant', version: '2.1.300', isSidechain: true, message: { model: 'claude-fable-5-2' } },
      { type: 'assistant', message: { model: '<synthetic>' } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );
  const { file } = await handleHook(event(root, { hook_event_name: 'UserPromptSubmit', prompt: 'again', transcript_path: transcript }), { env: { OPEN_PROMPTS_STATE_DIR: env.OPEN_PROMPTS_STATE_DIR }, now: NOW });
  const [record] = readJsonl(file);
  assert.equal(record.model, 'claude-haiku-5-5');
  assert.equal(record.agent_version, '2.1.300');
});

test('writes unknown values as null', async () => {
  const { root, env } = optedInRepo();
  const { file } = await handleHook(event(root, { hook_event_name: 'UserPromptSubmit', prompt: 'x' }), { env: { OPEN_PROMPTS_STATE_DIR: env.OPEN_PROMPTS_STATE_DIR }, now: NOW });
  const [record] = readJsonl(file);
  assert.equal(record.model, null);
  assert.equal(record.agent_version, null);
});

test('appends to the same file and skips duplicate prompt ids', async () => {
  const { root, env } = optedInRepo();
  const submit = async (prompt, id, now) => handleHook(event(root, { hook_event_name: 'UserPromptSubmit', prompt, prompt_id: id }), { env, now });
  const first = await submit('one', 'a', NOW);
  const second = await submit('two', 'b', new Date('2026-11-21T09:00:00Z'));
  const again = await submit('two', 'b', new Date('2026-11-21T09:00:01Z'));
  assert.equal(second.file, first.file, 'a session keeps its file across days');
  assert.equal(again.action, 'duplicate');
  assert.deepEqual(readJsonl(first.file).map((r) => r.prompt), ['one', 'two']);
});

test('uses the full session id when the short key belongs to another session', async () => {
  const { root, env, promptsDir } = optedInRepo();
  const a = await handleHook({ ...event(root, { hook_event_name: 'UserPromptSubmit', prompt: 'a' }), session_id: 'abcdefgh-1111' }, { env, now: NOW });
  const b = await handleHook({ ...event(root, { hook_event_name: 'UserPromptSubmit', prompt: 'b' }), session_id: 'abcdefgh-2222' }, { env, now: NOW });
  assert.equal(path.basename(a.file), '2026-11-20-abcdefgh.jsonl');
  assert.equal(path.basename(b.file), '2026-11-20-abcdefgh-2222.jsonl');
  const c = await handleHook({ ...event(root, { hook_event_name: 'UserPromptSubmit', prompt: 'c' }), session_id: 'abcdefgh-2222' }, { env, now: NOW });
  assert.equal(c.file, b.file);
  assert.equal(fs.readdirSync(promptsDir).length, 2);
});

test('writes nothing outside opted-in projects', async () => {
  const root = tempDir();
  const state = tempDir();
  const result = await handleHook(event(root, { hook_event_name: 'UserPromptSubmit', prompt: 'private work' }), { env: { OPEN_PROMPTS_STATE_DIR: state }, now: NOW });
  assert.equal(result.action, 'ignored');
  assert.deepEqual(fs.readdirSync(root), []);
  await handleHook(event(root, { hook_event_name: 'SessionStart', model: 'm' }), { env: { OPEN_PROMPTS_STATE_DIR: state } });
  assert.deepEqual(fs.readdirSync(state), [], 'no state either');
});

test('finds the project from a subdirectory and honours a custom dir', async () => {
  const { root, env } = optedInRepo();
  fs.writeFileSync(path.join(root, '.open-prompts.json'), JSON.stringify({ version: 1, dir: 'docs/prompts' }));
  fs.mkdirSync(path.join(root, 'src', 'app'), { recursive: true });
  const { file } = await handleHook(event(path.join(root, 'src', 'app'), { hook_event_name: 'UserPromptSubmit', prompt: 'x' }), { env, now: NOW });
  assert.equal(path.dirname(file), path.join(root, 'docs', 'prompts'));
});

test('pauses with OPEN_PROMPTS=off or a pause file', async () => {
  const { root, env, state, promptsDir } = optedInRepo();
  const submit = async (extraEnv) => handleHook(event(root, { hook_event_name: 'UserPromptSubmit', prompt: 'x' }), { env: { ...env, ...extraEnv }, now: NOW });
  assert.equal((await submit({ OPEN_PROMPTS: 'off' })).action, 'ignored');
  fs.writeFileSync(path.join(state, 'paused'), '');
  assert.equal((await submit({})).action, 'ignored');
  assert.equal(fs.existsSync(promptsDir), false);
});

test('ignores automated messages and subagents, redacts secrets', async () => {
  const { root, env } = optedInRepo();
  const submit = async (fields) => handleHook(event(root, { hook_event_name: 'UserPromptSubmit', ...fields }), { env, now: NOW });
  assert.equal((await submit({ prompt: '<task-notification>\n<task-id>1</task-id>' })).action, 'ignored');
  assert.equal((await submit({ prompt: '   \n ' })).action, 'ignored');
  assert.equal((await submit({ prompt: 'x', agent_id: 'sub-1' })).action, 'ignored');
  const result = await submit({ prompt: 'deploy with GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789AB' });
  assert.equal(result.action, 'recorded');
  assert.equal(readJsonl(result.file)[0].prompt, 'deploy with GITHUB_TOKEN=[REDACTED:github-token]');
});

test('cleanPrompt removes pasted-content wrappers and keeps the text', async () => {
  const pasted = 'look at this:\n<pasted_content id="ab12">\nError: boom\n  at x.js:1\n</pasted_content id="ab12">\nwhy?';
  assert.equal(cleanPrompt(pasted), 'look at this:\nError: boom\n  at x.js:1\nwhy?');
});

test('detectVersion reads the environment Claude Code sets', async () => {
  assert.equal(detectVersion({ AI_AGENT: 'claude-code_2-1-328_agent' }), '2.1.328');
  assert.equal(detectVersion({ CLAUDE_CODE_EXECPATH: '/Users/me/.local/share/claude/versions/2.1.330' }), '2.1.330');
  assert.equal(detectVersion({}), null);
});

test('extractPrompts keeps only what a person typed', async () => {
  const base = { sessionId: SESSION, version: '2.1.328', isSidechain: false };
  const entries = [
    { ...base, type: 'user', promptId: 'p1', timestamp: '2026-11-20T10:00:00Z', message: { role: 'user', content: 'first prompt' } },
    { ...base, type: 'assistant', message: { model: 'claude-opus-5-5', content: [] } },
    { ...base, type: 'user', promptId: 'p1', toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    { ...base, type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-5-5' } },
    { ...base, type: 'user', isSidechain: true, promptId: 'sub', message: { role: 'user', content: 'subagent prompt' } },
    { ...base, type: 'user', promptId: 'p2', timestamp: '2026-11-20T10:05:00Z', message: { role: 'user', content: '<command-message>ship</command-message>\n<command-name>/ship</command-name>\n<command-args>--fast</command-args>' } },
    { ...base, type: 'user', isMeta: true, message: { role: 'user', content: 'expanded skill text' } },
    { ...base, type: 'user', message: { role: 'user', content: '<local-command-stdout>done</local-command-stdout>' } },
    { ...base, type: 'user', message: { role: 'user', content: '[Request interrupted by user]' } },
    { ...base, type: 'user', promptId: 'p3', timestamp: '2026-11-20T10:09:00Z', message: { role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'what is in this screenshot?' }] } },
    { ...base, type: 'assistant', message: { model: 'claude-sonnet-5-5' } },
  ];
  assert.deepEqual(
    extractPrompts(entries).map(({ id, prompt, model }) => ({ id, prompt, model })),
    [
      { id: 'p1', prompt: 'first prompt', model: 'claude-opus-5-5' },
      { id: 'p2', prompt: '/ship --fast', model: null },
      { id: 'p3', prompt: 'what is in this screenshot?', model: 'claude-sonnet-5-5' },
    ],
  );
});

test('importTranscript writes records and does not duplicate them', async () => {
  const { root, promptsDir } = optedInRepo();
  const project = findProject(root);
  const transcript = path.join(tempDir(), `${SESSION}.jsonl`);
  const entries = [
    { type: 'user', sessionId: SESSION, version: '2.1.328', promptId: 'p1', timestamp: '2026-11-20T10:00:00Z', message: { role: 'user', content: 'hello' } },
    { type: 'assistant', sessionId: SESSION, message: { model: 'claude-opus-5-5' } },
  ];
  fs.writeFileSync(transcript, entries.map((e) => JSON.stringify(e)).join('\n'));
  assert.equal(importTranscript(transcript, project).written, 1);
  assert.deepEqual(importTranscript(transcript, project), { written: 0, skipped: 1, files: [path.join(promptsDir, '2026-11-20-234908e6.jsonl')], records: [] });
  assert.deepEqual(readJsonl(path.join(promptsDir, '2026-11-20-234908e6.jsonl')), [
    { v: 1, id: 'p1', timestamp: '2026-11-20T10:00:00Z', agent: 'claude-code', agent_version: '2.1.328', model: 'claude-opus-5-5', session: SESSION, prompt: 'hello' },
  ]);
});

test('replyModel finds the model of the first reply to a prompt', () => {
  const entries = [
    { type: 'user', promptId: 'p1', message: { content: 'one' } },
    { type: 'assistant', message: { model: 'claude-opus-5-5' } },
    { type: 'user', promptId: 'p2', message: { content: 'two' } },
    { type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-5-5' } },
    { type: 'assistant', message: { model: '<synthetic>' } },
    { type: 'assistant', message: { model: 'claude-sonnet-5-5' } },
  ];
  assert.equal(replyModel(entries, 'p1'), 'claude-opus-5-5');
  assert.equal(replyModel(entries, 'p2'), 'claude-sonnet-5-5');
  assert.equal(replyModel(entries, 'p3'), null);
});

test('waits for the reply and records the model that answered', async () => {
  const { root, env } = optedInRepo();
  const transcript = path.join(tempDir(), 't.jsonl');
  const line = (entry) => `${JSON.stringify(entry)}\n`;
  fs.writeFileSync(transcript, line({ type: 'user', promptId: 'p9', message: { content: 'go' } }));
  await handleHook(event(root, { hook_event_name: 'SessionStart', model: 'claude-opus-5-5' }), { env });
  setTimeout(() => fs.appendFileSync(transcript, line({ type: 'assistant', message: { model: 'us.anthropic.claude-opus-5-5-v1:0' } })), 400);

  const started = Date.now();
  const { file } = await handleHook(event(root, { hook_event_name: 'UserPromptSubmit', prompt: 'go', prompt_id: 'p9', transcript_path: transcript }), { env, now: NOW, waitMs: 5000 });
  assert.equal(readJsonl(file)[0].model, 'us.anthropic.claude-opus-5-5-v1:0');
  assert.ok(Date.now() - started < 3000);
});

test('stops waiting when aborted and falls back to the session model', async () => {
  const { root, env } = optedInRepo();
  const transcript = path.join(tempDir(), 't.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', promptId: 'p9', message: { content: 'go' } })}\n`);
  await handleHook(event(root, { hook_event_name: 'SessionStart', model: 'claude-opus-5-5' }), { env });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const started = Date.now();
  const { file } = await handleHook(event(root, { hook_event_name: 'UserPromptSubmit', prompt: 'go', prompt_id: 'p9', transcript_path: transcript }), { env, now: NOW, waitMs: 60_000, signal: controller.signal });
  assert.ok(Date.now() - started < 2000);
  assert.equal(readJsonl(file)[0].model, 'claude-opus-5-5');
});

test('cleanPrompt turns host citations into a quote and the comment', () => {
  const citations = [{ id: 'assistant-quote-1', citation: { version: 1, threadId: 'internal', text: 'Only Claude Code is supported.', comment: 'Can you support the other agents?' } }];
  const raw = `[assistant-quote-1]\n\n<assistant_citations>\nThe following citations refer to earlier assistant responses.\n${JSON.stringify(citations, null, 2)}\n</assistant_citations>`;
  assert.equal(cleanPrompt(raw), '> Only Claude Code is supported.\n\nCan you support the other agents?');
  assert.equal(cleanPrompt('see [1] in the list'), 'see [1] in the list');
});

test('extractPrompts keeps messages typed during a turn and skips turns the agent started', () => {
  const base = { sessionId: SESSION, version: '2.1.328', isSidechain: false };
  const entries = [
    { ...base, type: 'user', promptId: 'p1', timestamp: '2026-11-20T10:00:00Z', promptSource: 'sdk', message: { role: 'user', content: 'start' } },
    { ...base, type: 'assistant', message: { model: 'claude-opus-5-5' } },
    { ...base, type: 'attachment', uuid: 'u2', timestamp: '2026-11-20T10:01:00Z', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'also do this', source_uuid: 's2' } },
    { ...base, type: 'attachment', uuid: 'u3', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification>x' } },
    { ...base, type: 'assistant', message: { model: 'claude-opus-5-5' } },
    { ...base, type: 'user', promptId: 'p4', promptSource: 'system', turnOrigin: 'task_notification', origin: { kind: 'task-notification' }, message: { role: 'user', content: 'Background job finished' } },
    { ...base, type: 'user', promptId: 'p5', promptSource: 'sdk', message: { role: 'user', content: 'Update on pull request #1 (https://github.com/o/r/pull/1), which T3 Code is watching for you:\n- All 9 checks passed.' } },
    { ...base, type: 'user', promptId: 'p6', timestamp: '2026-11-20T10:09:00Z', promptSource: 'sdk', message: { role: 'user', content: 'Context handoff (delta_since_target_last_seen):\nProvider context handoff.\n[Historical user] /compact\n\nUser message:\ni merged the PR' } },
    { ...base, type: 'assistant', message: { model: 'claude-opus-5-5' } },
  ];
  assert.deepEqual(
    extractPrompts(entries).map(({ id, prompt }) => ({ id, prompt })),
    [
      { id: 'p1', prompt: 'start' },
      { id: 's2', prompt: 'also do this' },
      { id: 'p6', prompt: 'i merged the PR' },
    ],
  );
});

test('the hook skips host notifications and unwraps context handoffs', async () => {
  const { root, env } = optedInRepo();
  const submit = async (prompt) => handleHook(event(root, { hook_event_name: 'UserPromptSubmit', prompt }), { env, now: NOW });
  assert.equal((await submit('Update on pull request #3 (https://github.com/o/r/pull/3), which T3 Code is watching for you:\n- Checks passed.')).action, 'ignored');
  const result = await submit('Context handoff (delta_since_target_last_seen):\nsummary\n\nUser message:\nship it');
  assert.equal(readJsonl(result.file)[0].prompt, 'ship it');
  assert.equal((await submit('Context handoff (x):\nonly a summary')).action, 'ignored');
});

test('importTranscript with dryRun writes nothing', () => {
  const { root, promptsDir } = optedInRepo();
  const transcript = path.join(tempDir(), `${SESSION}.jsonl`);
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', sessionId: SESSION, promptId: 'p1', timestamp: '2026-11-20T10:00:00Z', message: { role: 'user', content: 'hello' } }) + '\n');
  const result = importTranscript(transcript, findProject(root), { dryRun: true });
  assert.equal(result.written, 1);
  assert.equal(result.records[0].prompt, 'hello');
  assert.equal(fs.existsSync(promptsDir), false);
});
