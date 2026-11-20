import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as codex from '../src/agents/codex.mjs';
import * as copilot from '../src/agents/copilot.mjs';
import * as cursor from '../src/agents/cursor.mjs';
import * as gemini from '../src/agents/gemini-cli.mjs';
import { createHooks, typedText } from '../src/agents/opencode.mjs';
import { detectAgent, runHook } from '../src/hook.mjs';
import { optedInRepo, readJsonl, tempDir } from './helpers.mjs';

const NOW = new Date('2026-11-20T15:48:02.123Z');
const only = (file) => readJsonl(file)[0];

test('detectAgent recognizes each payload', () => {
  assert.equal(detectAgent({ hook_event_name: 'UserPromptSubmit', session_id: 's', transcript_path: 't', permission_mode: 'default', prompt: 'x' }), 'claude-code');
  assert.equal(detectAgent({ hook_event_name: 'UserPromptSubmit', session_id: 's', turn_id: 't', model: 'gpt-5.6', prompt: 'x' }), 'codex');
  assert.equal(detectAgent({ hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c', cursor_version: '3.30.0', prompt: 'x' }), 'cursor');
  // Cursor running a hook that was installed for Claude Code
  assert.equal(detectAgent({ hook_event_name: 'UserPromptSubmit', conversation_id: 'c', generation_id: 'g', prompt: 'x' }), 'cursor');
  assert.equal(detectAgent({ hook_event_name: 'BeforeAgent', session_id: 's', transcript_path: 't', timestamp: '2026-11-20T00:00:00Z', prompt: 'x' }), 'gemini-cli');
  assert.equal(detectAgent({ sessionId: 's', timestamp: 1789776324620, cwd: '/x', prompt: 'x' }), 'copilot');
  // Copilot running a hook that was installed for Claude Code
  assert.equal(detectAgent({ hook_event_name: 'UserPromptSubmit', session_id: 's', timestamp: '2026-11-20T00:00:00Z', cwd: '/x', prompt: 'x' }), 'copilot');
});

test('codex: records prompt, model, and the version from the transcript', async () => {
  const { root, env } = optedInRepo();
  const transcript = path.join(tempDir(), 'rollout.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ timestamp: 'x', type: 'session_meta', payload: { cli_version: '0.171.0' } })}\n`);
  const input = { hook_event_name: 'UserPromptSubmit', session_id: 'thread-1', turn_id: 't1', prompt: 'fix the build', cwd: root, model: 'gpt-5.6-sol', transcript_path: transcript };
  const result = await codex.handle(input, { env, now: NOW });
  assert.deepEqual(only(result.file), { v: 1, timestamp: NOW.toISOString(), agent: 'codex', agent_version: '0.171.0', model: 'gpt-5.6-sol', session: 'thread-1', prompt: 'fix the build' });
  assert.equal((await codex.handle({ ...input, agent_id: 'sub' }, { env })).action, 'ignored');
});

test('cursor: uses the conversation, generation id and model id, and answers continue', async () => {
  const { root, env } = optedInRepo();
  const other = tempDir();
  const input = { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'conv-1', generation_id: 'gen-1', model: 'claude-opus-5-5-thinking-max', model_id: 'claude-opus-5-5', cursor_version: '3.30.0', workspace_roots: [other, root], prompt: 'add tests' };
  const result = await cursor.handle(input, { env, now: NOW });
  assert.deepEqual(only(result.file), { v: 1, id: 'gen-1', timestamp: NOW.toISOString(), agent: 'cursor', agent_version: '3.30.0', model: 'claude-opus-5-5', session: 'conv-1', prompt: 'add tests' });
  assert.equal(cursor.stdout(input), '{"continue":true}');
  // The same prompt through the Claude Code compatible hook is not written twice.
  const twice = await runHook({ ...input, hook_event_name: 'UserPromptSubmit' }, { env, now: NOW });
  assert.equal(twice.agent, 'cursor');
  assert.equal(twice.result.action, 'duplicate');
});

test('gemini-cli: cleans the prompt, then the background step finds the model of the reply', async () => {
  const { root, env } = optedInRepo();
  const transcript = path.join(tempDir(), 'session.jsonl');
  const line = (record) => `${JSON.stringify(record)}\n`;
  fs.writeFileSync(transcript, line({ sessionId: 'g-1', kind: 'main' }) + line({ type: 'gemini', model: 'gemini-old' }));
  const input = {
    hook_event_name: 'BeforeAgent',
    session_id: 'g-1',
    cwd: root,
    transcript_path: transcript,
    timestamp: '2026-11-20T15:48:02.000Z',
    prompt: 'explain @src/a.ts\n--- Content from referenced files ---\nContent from @src/a.ts:\nconst a = 1\n--- End of content ---',
  };
  const { action, payload } = await gemini.handle(input, { env });
  assert.equal(action, 'deferred');
  assert.equal(payload.prompt, 'explain @src/a.ts');

  setTimeout(() => fs.appendFileSync(transcript, line({ type: 'user', content: [{ text: 'explain' }] }) + line({ type: 'gemini', model: 'gemini-4-neon' })), 300);
  const result = await gemini.complete(payload, { env, waitMs: 5000 });
  const record = only(result.file);
  assert.equal(record.agent, 'gemini-cli');
  assert.equal(record.model, 'gemini-4-neon');
  assert.equal(record.timestamp, '2026-11-20T15:48:02.000Z');
  assert.equal(record.session, 'g-1');

  assert.equal((await gemini.handle({ ...input, prompt: '<session_context>\nx' }, { env })).action, 'ignored');
});

test('gemini-cli: falls back to the last model when no reply comes', async () => {
  const { root, env } = optedInRepo();
  const transcript = path.join(tempDir(), 'session.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'gemini', model: 'gemini-old' })}\n`);
  const { payload } = await gemini.handle({ hook_event_name: 'BeforeAgent', session_id: 'g', cwd: root, transcript_path: transcript, prompt: 'hi' }, { env });
  assert.equal(only((await gemini.complete(payload, { env, waitMs: 0 })).file).model, 'gemini-old');
});

test('copilot: the background step reads model and version from events.jsonl', async () => {
  const { root, env } = optedInRepo();
  const copilotHome = tempDir();
  const fullEnv = { ...env, COPILOT_HOME: copilotHome };
  const events = copilot.eventsFile('cs-1', fullEnv);
  fs.mkdirSync(path.dirname(events), { recursive: true });
  const line = (event) => `${JSON.stringify(event)}\n`;
  fs.writeFileSync(events, line({ type: 'session.start', data: { sessionId: 'cs-1', copilotVersion: '1.0.114', selectedModel: 'claude-sonnet-5-5' } }));

  const { action, payload } = await copilot.handle({ sessionId: 'cs-1', timestamp: 1789776324620, cwd: root, prompt: ' ship it ' }, { env: fullEnv });
  assert.equal(action, 'deferred');
  setTimeout(() => fs.appendFileSync(events, line({ type: 'user.message', data: { content: 'ship it' } }) + line({ type: 'assistant.usage', data: { model: 'gpt-5.6' } })), 300);
  const record = only((await copilot.complete(payload, { env: fullEnv, waitMs: 5000 })).file);
  assert.deepEqual(record, { v: 1, timestamp: new Date(1789776324620).toISOString(), agent: 'copilot', agent_version: '1.0.114', model: 'gpt-5.6', session: 'cs-1', prompt: 'ship it' });

  assert.equal((await copilot.handle({ sessionId: 'cs-1', cwd: root, prompt: 'x', agentId: 'a' }, { env: fullEnv })).action, 'ignored');
});

test('copilot: falls back to the selected model', async () => {
  const { root, env } = optedInRepo();
  const fullEnv = { ...env, COPILOT_HOME: tempDir() };
  const events = copilot.eventsFile('cs-2', fullEnv);
  fs.mkdirSync(path.dirname(events), { recursive: true });
  fs.writeFileSync(events, `${JSON.stringify({ type: 'session.start', data: { copilotVersion: '1.0.114', selectedModel: 'claude-sonnet-5-5' } })}\n`);
  const { payload } = await copilot.handle({ sessionId: 'cs-2', cwd: root, prompt: 'x' }, { env: fullEnv });
  assert.equal(only((await copilot.complete(payload, { env: fullEnv, waitMs: 0 })).file).model, 'claude-sonnet-5-5');
});

test('runHook hands deferred work to the background step', async () => {
  const { root, env } = optedInRepo();
  const calls = [];
  const outcome = await runHook(
    { hook_event_name: 'BeforeAgent', session_id: 'g', cwd: root, transcript_path: '', prompt: 'hi' },
    { agent: 'gemini-cli', env, defer: (agent, payload) => (calls.push({ agent, payload }), 'pending-file') },
  );
  assert.equal(outcome.result.action, 'deferred');
  assert.equal(calls[0].agent, 'gemini-cli');
  assert.equal(outcome.stdout, '');
});

test('opencode: records typed prompts and commands, skips subagent sessions', async () => {
  const { root, env } = optedInRepo();
  const sessions = { 'ses-main': { id: 'ses-main', version: '1.18.32', directory: root }, 'ses-child': { id: 'ses-child', parentID: 'ses-main', directory: root } };
  const client = { session: { get: async ({ path: { id } }) => ({ data: sessions[id] }) } };
  const hooks = createHooks({ client, directory: root, env });
  const message = (id, sessionID) => ({ id, sessionID, role: 'user', time: { created: Date.parse('2026-11-20T10:00:00Z') }, model: { providerID: 'openrouter', modelID: 'z-ai/glm-5.2' } });

  await hooks.event({ event: { type: 'session.created', properties: { info: sessions['ses-child'] } } });
  await hooks['chat.message']({ sessionID: 'ses-main' }, { message: message('msg-1', 'ses-main'), parts: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'file content', synthetic: true }] });
  await hooks['command.execute.before']({ command: 'review', sessionID: 'ses-main', arguments: '42' }, { parts: [] });
  await hooks['chat.message']({ sessionID: 'ses-main' }, { message: message('msg-2', 'ses-main'), parts: [{ type: 'text', text: 'expanded template' }] });
  await hooks['chat.message']({ sessionID: 'ses-child' }, { message: message('msg-3', 'ses-child'), parts: [{ type: 'text', text: 'subagent task' }] });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const file = path.join(root, 'prompts', '2026-11-20-ses-main.jsonl');
  assert.deepEqual(readJsonl(file), [
    { v: 1, id: 'msg-1', timestamp: '2026-11-20T10:00:00.000Z', agent: 'opencode', agent_version: '1.18.32', model: 'openrouter/z-ai/glm-5.2', session: 'ses-main', prompt: 'hello' },
    { v: 1, id: 'msg-2', timestamp: '2026-11-20T10:00:00.000Z', agent: 'opencode', agent_version: '1.18.32', model: 'openrouter/z-ai/glm-5.2', session: 'ses-main', prompt: '/review 42' },
  ]);
  assert.equal(fs.readdirSync(path.join(root, 'prompts')).length, 1);
});

test('opencode: a failing client never throws into OpenCode', async () => {
  const { root, env } = optedInRepo();
  const hooks = createHooks({ client: { session: { get: async () => { throw new Error('offline'); } } }, directory: root, env });
  await hooks['chat.message']({ sessionID: 's' }, { message: { id: 'm' }, parts: [{ type: 'text', text: 'x' }] });
  await hooks['chat.message'](undefined, undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(typedText([{ type: 'text', text: ' a ' }, { type: 'file' }]), 'a');
});

test('mistral-vibe: the background step waits for the reply, then reads the model from meta.json', async () => {
  const vibe = await import('../src/agents/vibe.mjs');
  const { root, env } = optedInRepo();
  const sessionDir = tempDir('vibe-session-');
  const line = (message) => `${JSON.stringify(message)}\n`;
  fs.writeFileSync(path.join(sessionDir, 'messages.jsonl'), line({ role: 'user', content: 'old' }) + line({ role: 'assistant', content: 'old answer' }));
  fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify({ session_id: 'v-1', config: { active_model: 'mistral-medium-3-5', model_name: 'mistral-medium-2511' } }));
  const input = { hook_event_name: 'pre_agent', session_id: 'v-1', parent_session_id: null, transcript_path: sessionDir, cwd: root, agent_name: 'default', turn_id: 'turn-1', prompt: 'refactor the parser' };

  assert.equal(detectAgent(input), 'mistral-vibe');
  const { action, payload } = await vibe.handle(input, { env, now: NOW });
  assert.equal(action, 'deferred');
  setTimeout(() => {
    fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify({ session_id: 'v-1', config: { active_model: 'devstral-3', model_name: 'devstral-2512' } }));
    fs.appendFileSync(path.join(sessionDir, 'messages.jsonl'), line({ role: 'user', content: 'refactor the parser' }) + line({ role: 'assistant', content: 'Sure' }));
  }, 300);
  const started = Date.now();
  const record = only((await vibe.complete(payload, { env, waitMs: 5000 })).file);
  assert.ok(Date.now() - started >= 250, 'waited for the reply');
  assert.deepEqual(record, { v: 1, timestamp: NOW.toISOString(), agent: 'mistral-vibe', agent_version: null, model: 'devstral-2512', session: 'v-1', prompt: 'refactor the parser' });
});

test('mistral-vibe: skips subagents and other events', async () => {
  const vibe = await import('../src/agents/vibe.mjs');
  const { root, env } = optedInRepo();
  const base = { session_id: 's', transcript_path: '', cwd: root, prompt: 'x' };
  assert.equal((await vibe.handle({ ...base, hook_event_name: 'pre_agent', parent_session_id: 'parent' }, { env })).action, 'ignored');
  assert.equal((await vibe.handle({ ...base, hook_event_name: 'post_agent' }, { env })).action, 'ignored');
  const { payload } = await vibe.handle({ ...base, hook_event_name: 'pre_agent', parent_session_id: null }, { env });
  assert.equal(only((await vibe.complete(payload, { env, waitMs: 0 })).file).model, null);
});

test('mistral-vibe: finds the version of a uv or pipx install', async () => {
  const { vibeVersion } = await import('../src/agents/vibe.mjs');
  const tool = tempDir('vibe-tool-');
  fs.mkdirSync(path.join(tool, 'bin'));
  fs.mkdirSync(path.join(tool, 'lib', 'python3.12', 'site-packages', 'mistral_vibe-3.1.4.dist-info'), { recursive: true });
  fs.writeFileSync(path.join(tool, 'bin', 'vibe'), '#!/bin/sh\n');
  const bin = tempDir('vibe-bin-');
  fs.symlinkSync(path.join(tool, 'bin', 'vibe'), path.join(bin, 'vibe'));
  assert.equal(vibeVersion({ PATH: [tempDir(), bin].join(path.delimiter) }), '3.1.4');
  assert.equal(vibeVersion({ PATH: tempDir() }), null);
});
