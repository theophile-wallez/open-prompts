import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/open-prompts', import.meta.url));

function setup() {
  const repo = tempDir();
  fs.mkdirSync(path.join(repo, '.git'));
  const env = { ...process.env, OPEN_PROMPTS_STATE_DIR: tempDir(), CLAUDE_CONFIG_DIR: tempDir(), OPEN_PROMPTS: '' };
  const run = (args, input, cwd = repo) => spawnSync(process.execPath, [BIN, ...args], { cwd, env, input, encoding: 'utf8' });
  return { repo, run };
}

test('init, hook, show, validate and status work end to end', () => {
  const { repo, run } = setup();
  const init = run(['init']);
  assert.equal(init.status, 0, init.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, '.open-prompts.json'), 'utf8')), { version: 1, dir: 'prompts' });
  assert.match(init.stdout, /No Open Prompts hooks found/);

  const hook = run(['hook'], JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'abc12345-x', cwd: repo, prompt: 'Write the README\nwith examples', prompt_id: 'p1' }));
  assert.equal(hook.status, 0);
  assert.equal(hook.stdout, '', 'hooks print nothing, so nothing is added to the conversation');

  const show = run(['show']);
  assert.match(show.stdout, /session abc12345-x · claude-code/);
  assert.match(show.stdout, /  Write the README\n  with examples/);

  const validate = run(['validate']);
  assert.equal(validate.status, 0, validate.stderr);
  assert.match(validate.stdout, /1 file checked, all valid/);

  assert.match(run(['status']).stdout, /1 prompts in 1 sessions/);
});

test('validate fails on a broken file', () => {
  const { repo, run } = setup();
  run(['init']);
  fs.writeFileSync(path.join(repo, 'prompts', '2026-11-20-bad.jsonl'), '{"v":1}\n');
  const result = run(['validate']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /2026-11-20-bad\.jsonl:1: "timestamp"/);
});

test('hook never fails, even on garbage input', () => {
  const { run } = setup();
  const result = run(['hook'], 'not json');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('pause and resume', () => {
  const { repo, run } = setup();
  run(['init']);
  run(['pause']);
  run(['hook'], JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1234567', cwd: repo, prompt: 'secret plan' }));
  assert.deepEqual(fs.readdirSync(path.join(repo, 'prompts')), []);
  assert.match(run(['status']).stdout, /Recording: paused/);
  run(['resume']);
  assert.match(run(['status']).stdout, /Recording: on/);
});

test('unknown commands exit with an error', () => {
  const { run } = setup();
  assert.equal(run(['nope']).status, 2);
});

test('hook reads a payload that arrives late on stdin', async () => {
  const { repo } = setup();
  spawnSync(process.execPath, [BIN, 'init'], { cwd: repo, encoding: 'utf8' });
  const { spawn } = await import('node:child_process');
  const env = { ...process.env, OPEN_PROMPTS_STATE_DIR: tempDir() };
  const child = spawn(process.execPath, [BIN, 'hook', '--agent', 'cursor'], { cwd: repo, env });
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  setTimeout(() => {
    child.stdin.end(JSON.stringify({ hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c', generation_id: 'g', workspace_roots: [repo], prompt: 'late' }));
  }, 500);
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
  assert.equal(stdout, '{"continue":true}');
  assert.equal(fs.readdirSync(path.join(repo, 'prompts')).length, 1);
});
