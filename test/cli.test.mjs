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

test('init keeps the prompts directory in git, and validate passes right after init', () => {
  const { repo, run } = setup();
  run(['init']);
  assert.equal(fs.readFileSync(path.join(repo, 'prompts', '.gitkeep'), 'utf8'), '');
  const validate = run(['validate']);
  assert.equal(validate.status, 0, validate.stderr);
  assert.match(validate.stdout, /^0 files checked, all valid\.$/m);

  // A fresh clone: git dropped the empty directory, and the configuration is there.
  fs.rmSync(path.join(repo, 'prompts'), { recursive: true });
  const clone = run(['validate']);
  assert.equal(clone.status, 0, clone.stderr);
  assert.match(clone.stdout, /0 files checked, all valid/);
  assert.match(run(['status']).stdout, /0 prompts in 0 sessions/);

  // A path given on the command line must exist.
  const missing = run(['validate', 'nowhere']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /nowhere: not found/);
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
  assert.deepEqual(fs.readdirSync(path.join(repo, 'prompts')), ['.gitkeep']);
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
  assert.equal(fs.readdirSync(path.join(repo, 'prompts')).filter((name) => name.endsWith('.jsonl')).length, 1);
});

// ---------------------------------------------------------------------------
// audit

const record = (prompt, n = 1) =>
  `${JSON.stringify({ v: 1, id: `p${n}`, timestamp: '2026-11-20T10:00:00Z', agent: 'claude-code', agent_version: null, model: null, session: 'abc12345-x', prompt })}\n`;

test('audit lists what to read, masks it, and exits with 1', () => {
  const { repo, run } = setup();
  run(['init']);
  const file = path.join(repo, 'prompts', '2026-11-20-abc12345.jsonl');
  fs.writeFileSync(
    file,
    record('Write the README', 1) +
      record('log in with jane.doe@example.com Tr0ub4dor&3', 2) +
      record('use the key Zx8kQ2mP9vL4tR7wN3bYq1 for staging', 3) +
      record('le mot de passe : chocolat', 4) +
      record('see commit 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f and [REDACTED:github-token]', 5),
  );
  const result = run(['audit']);
  assert.equal(result.status, 1, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.match(lines[0], /^prompts\/2026-11-20-abc12345\.jsonl:2: email and password: log in with jan…$/);
  assert.match(result.stdout, /:3: high-entropy string: use the key Zx8… for staging/);
  assert.match(result.stdout, /:4: password or secret keyword: le mot de passe : cho…/);
  assert.doesNotMatch(result.stdout, /:1:|:5:/, 'ordinary prompts, commit SHAs and redaction markers are not flagged');
  assert.doesNotMatch(result.stdout, /Tr0ub4dor|example\.com Tr0/, 'flagged values are masked');
  assert.match(lines.at(-1), /^3 findings in 3 of 5 records\./);
});

test('audit exits with 0 when nothing is flagged, and takes paths', () => {
  const { repo, run } = setup();
  run(['init']);
  fs.writeFileSync(path.join(repo, 'prompts', '2026-11-20-abc12345.jsonl'), record('send it to the team please') + record('password is required', 2));
  const result = run(['audit']);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /^2 records checked, nothing flagged\.$/m);
  fs.writeFileSync(path.join(repo, 'other.jsonl'), record('ping foo@bar.com'));
  const flagged = run(['audit', 'other.jsonl']);
  assert.equal(flagged.status, 1);
  assert.match(flagged.stdout, /^other\.jsonl:1: email: ping foo…$/m);
});

test('audit reports long pasted logs and home directories, unless homePaths is off', () => {
  const { repo, run } = setup();
  run(['init']);
  const log = Array.from({ length: 12 }, (_, i) => `2026-11-20T10:00:0${i % 10}Z ERROR worker ${i} crashed`).join('\n');
  fs.writeFileSync(path.join(repo, 'prompts', '2026-11-20-abc12345.jsonl'), record(`why?\n${log}`) + record('open /Users/janedoe/app', 2));
  const result = run(['audit']);
  assert.match(result.stdout, /:1: pasted log \(12 log lines\): why\? 2026-11-20/);
  assert.match(result.stdout, /:2: home directory: open \/Users\/jan…\/app/);
  fs.writeFileSync(path.join(repo, '.open-prompts.json'), JSON.stringify({ version: 1, dir: 'prompts', redact: { homePaths: false } }));
  assert.doesNotMatch(run(['audit']).stdout, /home directory/);
});

/** A git repository that opted in, with git isolated from the user's configuration. */
function gitSetup() {
  const { repo, run } = setup();
  fs.rmSync(path.join(repo, '.git'), { recursive: true });
  const home = tempDir();
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git('init', '-q');
  run(['init']);
  return { repo, run, git };
}

test('audit --staged checks only the records added in staged changes, as staged', () => {
  const { repo, run, git } = gitSetup();
  const file = path.join(repo, 'prompts', '2026-11-20-abc12345.jsonl');
  // An old record with an email, already committed: not checked again.
  fs.writeFileSync(file, record('ping foo@bar.com', 1));
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'first');

  fs.appendFileSync(file, record('add a test', 2));
  git('add', file);
  // A flagged record in the working tree only: not what would be committed.
  fs.appendFileSync(file, record('connecte toi: jane.doe@example.com Tr0ub4dor&3', 3));
  const clean = run(['audit', '--staged']);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /^1 staged record checked, nothing flagged\.$/m);

  git('add', file);
  const flagged = run(['audit', '--staged']);
  assert.equal(flagged.status, 1, flagged.stderr);
  assert.match(flagged.stdout, /^prompts\/2026-11-20-abc12345\.jsonl:3: email and password: connecte toi: jan…$/m);
  assert.doesNotMatch(flagged.stdout, /:1:/);
  assert.match(flagged.stdout, /1 finding in 1 of 2 staged records\./);
});

test('audit --staged sees new files, ignores other files, and works from a subdirectory', () => {
  const { repo, run, git } = gitSetup();
  fs.writeFileSync(path.join(repo, 'prompts', '2026-11-20-abc12345.jsonl'), record('token: Zx8kQ2mP9vL4'));
  fs.writeFileSync(path.join(repo, 'notes.jsonl'), record('ping foo@bar.com'));
  git('add', '-A');
  const result = run(['audit', '--staged'], undefined, path.join(repo, 'prompts'));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^2026-11-20-abc12345\.jsonl:1: password or secret keyword: token: Zx8…$/m);
  assert.doesNotMatch(result.stdout, /notes\.jsonl/);
});

test('audit --staged reads a prompts directory with a space in its name, and files marked -diff', () => {
  const { repo, run, git } = gitSetup();
  fs.writeFileSync(path.join(repo, '.open-prompts.json'), JSON.stringify({ version: 1, dir: 'my prompts' }));
  fs.mkdirSync(path.join(repo, 'my prompts'));
  fs.writeFileSync(path.join(repo, 'my prompts', '2026-11-20-abc12345.jsonl'), record('the password is Tr0ub4dor&3x'));
  git('add', '-A');
  const spaced = run(['audit', '--staged']);
  assert.equal(spaced.status, 1, spaced.stdout + spaced.stderr);
  assert.match(spaced.stdout, /^my prompts\/2026-11-20-abc12345\.jsonl:1: /m);

  git('commit', '-q', '--no-verify', '-m', 'first');
  fs.writeFileSync(path.join(repo, '.open-prompts.json'), JSON.stringify({ version: 1, dir: 'prompts' }));
  fs.writeFileSync(path.join(repo, '.gitattributes'), 'prompts/*.jsonl -diff\n');
  fs.writeFileSync(path.join(repo, 'prompts', '2026-11-20-abc12345.jsonl'), record('add a test') + record('token: Zx8kQ2mP9vL4tR7wN3bY', 2));
  git('add', '-A');
  const binary = run(['audit', '--staged']);
  assert.equal(binary.status, 1, binary.stdout + binary.stderr);
  assert.match(binary.stdout, /^prompts\/2026-11-20-abc12345\.jsonl:2: /m);
  assert.match(binary.stdout, /1 finding in 1 of 2 staged records\./);
});

test('audit --staged outside a git repository explains why', () => {
  const { repo, run } = setup();
  run(['init']);
  fs.rmSync(path.join(repo, '.git'), { recursive: true });
  const result = run(['audit', '--staged'], undefined, repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /audit --staged: .*not a git repository/i);
});

// ---------------------------------------------------------------------------
// install

test('install copies the runtime, points the hooks to it, and status reports hooks that broke', () => {
  const home = tempDir('open-prompts-home-');
  const data = path.join(home, 'data', 'open-prompts');
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    COPILOT_HOME: path.join(home, '.copilot'),
    VIBE_HOME: path.join(home, '.vibe'),
    OPENCODE_CONFIG_DIR: path.join(home, '.config', 'opencode'),
    OPEN_PROMPTS_DATA_DIR: data,
    OPEN_PROMPTS_STATE_DIR: path.join(home, 'state'),
  };
  const run = (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: home, env, encoding: 'utf8' });
  const install = run(['install', '--agent', 'codex', '--node', process.execPath]);
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /Copied open-prompts \S+ to .*data\/open-prompts\. The hooks run it from there with /);
  const command = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8')).hooks.UserPromptSubmit[0].hooks[0].command;
  assert.equal(command, `'${process.execPath}' '${path.join(data, 'bin', 'open-prompts')}' hook --agent codex`);
  const copy = spawnSync(process.execPath, [path.join(data, 'bin', 'open-prompts'), '--version'], { encoding: 'utf8' });
  assert.equal(copy.stdout.trim(), JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.match(run(['install', '--agent', 'codex', '--node', process.execPath]).stdout, /is up to date in/);

  const status = run(['status']);
  assert.match(status.stdout, /Agents: {4}Codex/);
  assert.doesNotMatch(status.stdout, /Broken/);
  assert.match(status.stdout, /^Hooks run: .*data\/open-prompts \(open-prompts [^,]+\)$/m);
  const manifest = path.join(data, '.open-prompts-runtime.json');
  fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, 'utf8')), version: '0.0.1' }));
  assert.match(run(['status']).stdout, /\(open-prompts 0\.0\.1, while this is \S+: run "open-prompts install" to update it\)/);
  fs.rmSync(data, { recursive: true });
  assert.match(run(['status']).stdout, /^Broken: {4}Codex runs .*bin\/open-prompts, which no longer exists\. Run "open-prompts install" again\.$/m);

  run(['install', '--agent', 'codex', '--node', process.execPath]);
  const uninstall = run(['uninstall']);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.match(uninstall.stdout, /Codex: hooks removed/);
  assert.match(uninstall.stdout, /Removed the copy of open-prompts/);
  assert.equal(fs.existsSync(data), false);

  const bad = run(['install', '--agent', 'codex', '--node', path.join(home, 'nope')]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--node: .*nope does not exist/);
});
