import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { handle as claudeHook } from '../src/agents/claude-code.mjs';
import { writePrompt } from '../src/core.mjs';
import { findProject } from '../src/project.mjs';
import { SPOOL_MAX_AGE_DAYS, collect, pruneSpool, readSpool, repositoryId, spoolDirOf, updateSpooled } from '../src/spool.mjs';
import { listFiles } from '../src/store.mjs';
import { readJsonl, tempDir } from './helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/open-prompts', import.meta.url));
const CONFIG = JSON.stringify({ version: 1, dir: 'prompts' });

/**
 * A main checkout and a worktree of it, both opted in, laid out the way git lays them out:
 * the worktree's `.git` file points into the main `.git`, whose `commondir` leads back.
 */
function repoWithWorktree() {
  const main = tempDir();
  fs.mkdirSync(path.join(main, '.git', 'worktrees', 'task'), { recursive: true });
  fs.writeFileSync(path.join(main, '.git', 'worktrees', 'task', 'commondir'), '../..\n');
  fs.writeFileSync(path.join(main, '.open-prompts.json'), CONFIG);
  const worktree = path.join(tempDir('open-prompts-worktrees-'), 'task');
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'task')}\n`);
  fs.writeFileSync(path.join(worktree, '.open-prompts.json'), CONFIG);
  const env = { OPEN_PROMPTS_STATE_DIR: tempDir('open-prompts-state-') };
  return { main, worktree, env };
}

const prompt = (fields) => ({ agent: 'codex', session: 'sess-aaaa-1111', timestamp: '2026-11-20T10:00:00.000Z', prompt: 'hello', ...fields });

test('a worktree and its main checkout share one spool, keyed by the git common directory', () => {
  const { main, worktree, env } = repoWithWorktree();
  assert.equal(repositoryId(worktree), fs.realpathSync(path.join(main, '.git')));
  assert.equal(spoolDirOf(findProject(worktree), env), spoolDirOf(findProject(main), env));
  const other = tempDir();
  fs.mkdirSync(path.join(other, '.git'));
  fs.writeFileSync(path.join(other, '.open-prompts.json'), CONFIG);
  assert.notEqual(spoolDirOf(findProject(other), env), spoolDirOf(findProject(main), env));
});

test('collect brings back the prompts of a deleted worktree, in their session files', async () => {
  const { main, worktree, env } = repoWithWorktree();
  const project = findProject(worktree);
  writePrompt(project, prompt({ id: 'p1', prompt: 'first' }), { env });
  writePrompt(project, prompt({ id: 'p2', prompt: 'second', timestamp: '2026-11-20T10:05:00.000Z' }), { env });
  writePrompt(project, prompt({ session: 'other-session', prompt: 'no id here', timestamp: '2026-11-21T09:00:00.000Z' }), { env });
  // The Claude Code hook goes through writePrompt too.
  await claudeHook({ hook_event_name: 'UserPromptSubmit', session_id: 'c1aude00-0000', cwd: worktree, prompt: 'from claude', prompt_id: 'cp1' }, { env: { ...env, OPEN_PROMPTS_WAIT_MS: '0' }, now: new Date('2026-11-22T08:00:00Z') });
  assert.equal(readSpool(project, env).entries.length, 4);
  assert.ok(readSpool(project, env).entries.every(({ checkout }) => checkout === fs.realpathSync(worktree)));
  fs.rmSync(worktree, { recursive: true });

  const home = findProject(main);
  const dry = collect(home, { dryRun: true, env });
  assert.equal(dry.added, 4);
  assert.deepEqual(listFiles(home.promptsDir), [], 'a dry run writes nothing');

  const result = collect(home, { env });
  assert.equal(result.added, 4);
  assert.equal(result.present, 0);
  assert.deepEqual(result.files.map((file) => path.basename(file)).sort(), ['2026-11-20-sess-aaa.jsonl', '2026-11-21-other-se.jsonl', '2026-11-22-c1aude00.jsonl']);
  assert.deepEqual(readJsonl(path.join(home.promptsDir, '2026-11-20-sess-aaa.jsonl')).map((record) => record.prompt), ['first', 'second']);

  const again = collect(home, { env });
  assert.equal(again.added, 0);
  assert.equal(again.present, 4);
});

test('collect adds only what a session file is missing, and keeps lines edited by hand', () => {
  const { main, env } = repoWithWorktree();
  const project = findProject(main);
  writePrompt(project, prompt({ id: 'p1', prompt: 'token is Zx8kQ2mP9vL4tR7wN3' }), { env });
  writePrompt(project, prompt({ prompt: 'no id', timestamp: '2026-11-20T10:01:00.000Z' }), { env });
  writePrompt(project, prompt({ id: 'p3', prompt: 'third', timestamp: '2026-11-20T10:02:00.000Z' }), { env });
  const file = listFiles(project.promptsDir)[0];
  // The person redacts the first two lines by hand and loses the third.
  const [first, second] = readJsonl(file);
  fs.writeFileSync(file, `${JSON.stringify({ ...first, prompt: 'token is [removed]' })}\n${JSON.stringify({ ...second, prompt: 'no [removed]' })}\n`);
  const result = collect(project, { env });
  assert.equal(result.added, 1);
  assert.equal(result.present, 2);
  assert.deepEqual(readJsonl(file).map((record) => record.prompt), ['token is [removed]', 'no [removed]', 'third']);
});

test('collect leaves out the prompts of a worktree that still exists', () => {
  const { main, worktree, env } = repoWithWorktree();
  writePrompt(findProject(worktree), prompt({ id: 'p1' }), { env });
  writePrompt(findProject(main), prompt({ id: 'm1', session: 'main-session' }), { env });
  const home = findProject(main);
  fs.rmSync(home.promptsDir, { recursive: true });
  const result = collect(home, { env });
  assert.deepEqual(result.records.map(({ record }) => record.id), ['m1'], 'the records of this checkout come back');
  assert.deepEqual([...result.live], [[fs.realpathSync(worktree), 1]]);
  assert.equal(fs.existsSync(path.join(main, 'prompts', '2026-11-20-sess-aaa.jsonl')), false);
});

test('collect leaves out a session whose file is in another branch', () => {
  const main = tempDir();
  const home = tempDir('open-prompts-home-');
  const gitEnv = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: main, env: gitEnv, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q');
  fs.writeFileSync(path.join(main, '.open-prompts.json'), CONFIG);
  git('add', '-A');
  git('commit', '-q', '-m', 'opt in');
  const env = { OPEN_PROMPTS_STATE_DIR: tempDir('open-prompts-state-') };
  // A task branch commits its first prompt; the second one was never committed.
  git('checkout', '-q', '-b', 'task');
  const project = findProject(main);
  writePrompt(project, prompt({ id: 'p1' }), { env });
  git('add', '-A');
  git('commit', '-q', '-m', 'task');
  writePrompt(project, prompt({ id: 'p2', timestamp: '2026-11-20T10:05:00.000Z' }), { env });
  fs.rmSync(project.promptsDir, { recursive: true });
  git('checkout', '-q', 'main');
  writePrompt(project, prompt({ id: 'x1', session: 'unrelated-session' }), { env });
  fs.rmSync(project.promptsDir, { recursive: true });

  const result = collect(project, { env });
  assert.deepEqual(result.records.map(({ record }) => record.id), ['x1']);
  assert.deepEqual([...result.committed], [[path.join(project.promptsDir, '2026-11-20-sess-aaa.jsonl'), 2]]);
  git('merge', '-q', 'task');
  const merged = collect(project, { env });
  assert.deepEqual(merged.records.map(({ record }) => record.id), ['p2'], 'once merged, the missing record is added to the file');
  assert.deepEqual(readJsonl(path.join(project.promptsDir, '2026-11-20-sess-aaa.jsonl')).map((record) => record.id), ['p1', 'p2']);
});

test('edits and deletions made in the interface reach the spool', () => {
  const { main, env } = repoWithWorktree();
  const project = findProject(main);
  const kept = writePrompt(project, prompt({ id: 'p1', prompt: 'keep' }), { env }).record;
  const gone = writePrompt(project, prompt({ id: 'p2', prompt: 'remove me', timestamp: '2026-11-20T10:01:00.000Z' }), { env }).record;
  updateSpooled(project, kept, { ...kept, prompt: 'kept, edited' }, env);
  updateSpooled(project, gone, null, env);
  assert.deepEqual(readSpool(project, env).entries.map(({ record }) => record.prompt), ['kept, edited']);
});

test('nothing is spooled with "spool": false, OPEN_PROMPTS_SPOOL=off, a dry run, or for imports', () => {
  const { main, env } = repoWithWorktree();
  const project = findProject(main);
  writePrompt(project, prompt({ id: 'a' }), { env: { ...env, OPEN_PROMPTS_SPOOL: 'off' } });
  writePrompt(project, prompt({ id: 'b' }), { env, dryRun: true });
  writePrompt(project, prompt({ id: 'c' }), { env, spool: false });
  fs.writeFileSync(path.join(main, '.open-prompts.json'), JSON.stringify({ version: 1, spool: false }));
  writePrompt(findProject(main), prompt({ id: 'd' }), { env });
  assert.equal(fs.existsSync(spoolDirOf(project, env)), false);
});

test('spooled sessions are pruned once they are old', () => {
  const { main, env } = repoWithWorktree();
  const project = findProject(main);
  writePrompt(project, prompt({ id: 'old' }), { env });
  writePrompt(project, prompt({ id: 'new', session: 'fresh-session' }), { env });
  const dir = spoolDirOf(project, env);
  const old = new Date(Date.now() - (SPOOL_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000);
  fs.utimesSync(path.join(dir, 'sess-aaaa-1111.jsonl'), old, old);
  assert.equal(pruneSpool(env), 1);
  assert.deepEqual(readSpool(project, env).entries.map(({ record }) => record.id), ['new']);
  fs.utimesSync(path.join(dir, 'fresh-session.jsonl'), old, old);
  pruneSpool(env);
  assert.equal(fs.existsSync(dir), false, 'a repository with no session left is removed');
});

test('open-prompts collect, end to end', () => {
  const { main, worktree, env } = repoWithWorktree();
  const run = (args, cwd, input) =>
    spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: 'utf8', env: { ...process.env, ...env, OPEN_PROMPTS: '', OPEN_PROMPTS_WAIT_MS: '0' } });
  const hook = run(['hook'], worktree, JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'abc12345-x', cwd: worktree, prompt: 'Write the README', prompt_id: 'p1' }));
  assert.equal(hook.status, 0);
  assert.equal(hook.stdout, '');
  fs.rmSync(worktree, { recursive: true });

  const dry = run(['collect', '--dry-run'], main);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /  Write the README/);
  assert.match(dry.stdout, /^1 prompt would be added in 1 session\.$/m);
  assert.equal(fs.existsSync(path.join(main, 'prompts')), false);

  const real = run(['collect'], main);
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /^prompts\/\d{4}-\d{2}-\d{2}-abc12345\.jsonl$/m);
  assert.match(real.stdout, /^1 prompt added in 1 session\.$/m);
  assert.match(run(['collect'], main).stdout, /^0 prompts added, 1 already there\.$/m);
});
