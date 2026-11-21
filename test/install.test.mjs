import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { AGENTS, configPath, detectInstalledAgents, installAgent, installedPaths, isAgentInstalled, missingPaths, uninstallAgent } from '../src/install.mjs';
import { installRuntime, pickNode, removeRuntime, runtimeDir, unstableNode } from '../src/runtime.mjs';
import { tempDir } from './helpers.mjs';

const paths = { nodePath: '/usr/bin/node', scriptPath: '/opt/open-prompts/bin/open-prompts' };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function withHome(fn) {
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  const home = tempDir('open-prompts-home-');
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  const env = { HOME: home };
  try {
    return fn(home, env);
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('every agent installs, is detected, and uninstalls cleanly', () =>
  withHome((home, env) => {
    for (const agent of AGENTS) {
      installAgent(agent, { ...paths, env });
      installAgent(agent, { ...paths, env }); // idempotent
      assert.ok(isAgentInstalled(agent, env), agent);
      assert.equal(uninstallAgent(agent, { env }), true, agent);
      assert.equal(isAgentInstalled(agent, env), false, agent);
    }
  }));

test('installs keep the rest of each configuration', () =>
  withHome((home, env) => {
    const codexFile = configPath('codex', env);
    fs.mkdirSync(path.dirname(codexFile), { recursive: true });
    const theirs = { type: 'command', command: 'say hi' };
    fs.writeFileSync(codexFile, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [theirs] }], Stop: [{ hooks: [theirs] }] } }));
    installAgent('codex', { ...paths, env });
    installAgent('codex', { ...paths, env });
    const codex = read(codexFile);
    assert.equal(codex.hooks.UserPromptSubmit.length, 2);
    assert.equal(codex.hooks.UserPromptSubmit[1].hooks[0].command, "'/usr/bin/node' '/opt/open-prompts/bin/open-prompts' hook --agent codex");
    uninstallAgent('codex', { env });
    assert.deepEqual(read(codexFile), { hooks: { UserPromptSubmit: [{ hooks: [theirs] }], Stop: [{ hooks: [theirs] }] } });

    const geminiFile = configPath('gemini-cli', env);
    fs.mkdirSync(path.dirname(geminiFile), { recursive: true });
    fs.writeFileSync(geminiFile, JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }));
    installAgent('gemini-cli', { ...paths, env });
    const gemini = read(geminiFile);
    assert.equal(gemini.security.auth.selectedType, 'oauth-personal');
    assert.deepEqual(gemini.hooks.BeforeAgent[0].hooks[0], {
      name: 'open-prompts',
      type: 'command',
      command: "'/usr/bin/node' '/opt/open-prompts/bin/open-prompts' hook --agent gemini-cli",
      timeout: 10000,
    });
    uninstallAgent('gemini-cli', { env });
    assert.deepEqual(read(geminiFile), { security: { auth: { selectedType: 'oauth-personal' } } });

    installAgent('cursor', { ...paths, env });
    assert.deepEqual(read(configPath('cursor', env)), {
      version: 1,
      hooks: { beforeSubmitPrompt: [{ command: "'/usr/bin/node' '/opt/open-prompts/bin/open-prompts' hook --agent cursor", timeout: 10 }] },
    });

    installAgent('claude-code', { ...paths, env });
    const claude = read(configPath('claude-code', env));
    assert.deepEqual(Object.keys(claude.hooks), ['SessionStart', 'UserPromptSubmit', 'PostModelSwitch']);
    assert.equal(claude.hooks.UserPromptSubmit[0].hooks[0].async, true);

    installAgent('opencode', { ...paths, env });
    assert.match(fs.readFileSync(configPath('opencode', env), 'utf8'), /export const OpenPrompts = async \(input\) => \(await import\("file:\/\/\/opt\/open-prompts\/src\/opencode-plugin\.mjs"\)\)\.OpenPrompts\(input\);/);
  }));

test('refuses to overwrite a file it cannot parse', () =>
  withHome((home, env) => {
    const file = configPath('cursor', env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ "version": 1, }');
    assert.throws(() => installAgent('cursor', { ...paths, env }), /Could not parse/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ "version": 1, }');
  }));

test('detects agents from their configuration directories', () =>
  withHome((home, env) => {
    assert.deepEqual(detectInstalledAgents(env), []);
    fs.mkdirSync(path.join(home, '.gemini'));
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    assert.deepEqual(detectInstalledAgents(env), ['gemini-cli', 'opencode']);
  }));

test('mistral-vibe: the hook goes in a marked block of hooks.toml, next to existing hooks', () =>
  withHome((home, env) => {
    const file = configPath('mistral-vibe', env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const theirs = '[[hooks]]\nname = "lint"\ntype = "post_agent"\ncommand = "eslint ."\n';
    fs.writeFileSync(file, theirs);
    installAgent('mistral-vibe', { ...paths, env });
    installAgent('mistral-vibe', { ...paths, env }); // idempotent
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.startsWith(theirs));
    assert.equal(text.match(/name = "open-prompts"/g).length, 1);
    assert.match(text, /type = "pre_agent"\nmatch = "main"\ncommand = "'\/usr\/bin\/node' '\/opt\/open-prompts\/bin\/open-prompts' hook --agent mistral-vibe"/);
    assert.ok(isAgentInstalled('mistral-vibe', env));
    assert.equal(uninstallAgent('mistral-vibe', { env }), true);
    assert.equal(fs.readFileSync(file, 'utf8'), theirs);
    assert.equal(uninstallAgent('mistral-vibe', { env }), false);
  }));

// ---------------------------------------------------------------------------
// Where the hooks run from

test('installRuntime copies what the hooks need, once, and replaces it in one step', () => {
  const source = tempDir('open-prompts-source-');
  for (const [file, content] of [
    ['bin/open-prompts', "import('../src/cli.mjs');\n"],
    ['src/cli.mjs', 'export const a = 1;\n'],
    ['src/agents/codex.mjs', 'export const b = 2;\n'],
    ['src/.DS_Store', 'junk'],
    ['package.json', '{"version":"9.9.9"}\n'],
    ['test/skip.test.mjs', 'not copied'],
  ]) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), content);
  }
  const env = { OPEN_PROMPTS_DATA_DIR: path.join(tempDir('open-prompts-data-'), 'open-prompts') };
  assert.equal(runtimeDir(env), env.OPEN_PROMPTS_DATA_DIR);
  const first = installRuntime(source, env);
  assert.equal(first.copied, true);
  assert.equal(first.scriptPath, path.join(env.OPEN_PROMPTS_DATA_DIR, 'bin', 'open-prompts'));
  assert.equal(fs.readFileSync(path.join(first.dir, 'src', 'agents', 'codex.mjs'), 'utf8'), 'export const b = 2;\n');
  assert.equal(fs.existsSync(path.join(first.dir, 'test')), false);
  assert.equal(fs.existsSync(path.join(first.dir, 'src', '.DS_Store')), false);
  assert.equal(installRuntime(source, env).copied, false, 'the same files are not copied again');

  fs.writeFileSync(path.join(source, 'src', 'cli.mjs'), 'export const a = 3;\n');
  fs.rmSync(path.join(source, 'src', 'agents', 'codex.mjs'));
  assert.equal(installRuntime(source, env).copied, true);
  assert.equal(fs.readFileSync(path.join(first.dir, 'src', 'cli.mjs'), 'utf8'), 'export const a = 3;\n');
  assert.equal(fs.existsSync(path.join(first.dir, 'src', 'agents', 'codex.mjs')), false, 'files gone from the source are gone from the copy');
  assert.deepEqual(fs.readdirSync(path.dirname(first.dir)), ['open-prompts'], 'no temporary directory is left');

  assert.equal(installRuntime(first.dir, env).copied, false, 'installing from the copy itself keeps it');
  assert.equal(removeRuntime(env), true);
  assert.equal(fs.existsSync(first.dir), false);
  assert.equal(removeRuntime(env), false);
});

test('removeRuntime leaves a directory that is not a runtime copy', () => {
  const dir = tempDir('open-prompts-data-');
  fs.writeFileSync(path.join(dir, 'mine.txt'), 'keep');
  assert.equal(removeRuntime({ OPEN_PROMPTS_DATA_DIR: dir }), false);
  assert.ok(fs.existsSync(path.join(dir, 'mine.txt')));
});

test('the Node.js of a version manager is replaced by a system-wide one when there is one', () => {
  for (const file of [
    '/Users/jane/.nvm/versions/node/v22.1.0/bin/node',
    '/home/jane/.local/share/fnm/node-versions/v20.0.0/installation/bin/node',
    '/Users/jane/.volta/tools/image/node/20.1.0/bin/node',
    '/home/jane/.asdf/installs/nodejs/20.1.0/bin/node',
    '/home/jane/.local/share/mise/installs/node/22/bin/node',
    '/opt/homebrew/Cellar/node/22.1.0/bin/node',
    '/repo/node_modules/node/bin/node',
  ]) {
    assert.ok(unstableNode(file), file);
  }
  for (const file of ['/usr/bin/node', '/opt/homebrew/bin/node', '/usr/local/bin/node', 'C:\\Program Files\\nodejs\\node.exe']) assert.equal(unstableNode(file), null, file);

  const bin = tempDir('open-prompts-bin-');
  const old = path.join(bin, 'old-node');
  const good = path.join(bin, 'node');
  const managed = path.join(bin, '.nvm', 'node');
  const link = path.join(bin, 'linked-node');
  for (const file of [old, good]) fs.writeFileSync(file, '');
  fs.mkdirSync(path.dirname(managed));
  fs.writeFileSync(managed, '');
  fs.symlinkSync(managed, link);
  const majors = { [old]: 14, [good]: 20, [managed]: 22, [link]: 22 };
  const majorOf = (file) => majors[file] ?? null;
  const execPath = '/Users/jane/.nvm/versions/node/v22.1.0/bin/node';

  assert.deepEqual(pickNode({ execPath: '/usr/bin/node', candidates: [good], majorOf }), { nodePath: '/usr/bin/node', warning: null });
  assert.deepEqual(pickNode({ execPath, candidates: [path.join(bin, 'missing'), link, old, good], majorOf }), { nodePath: good, warning: null });
  const kept = pickNode({ execPath, candidates: [link, old], majorOf });
  assert.equal(kept.nodePath, execPath);
  assert.match(kept.warning, /managed by nvm/);
  assert.match(kept.warning, /linked-node \(a link into a version manager\), .*old-node \(Node\.js 14, too old\)/);
  assert.match(kept.warning, /open-prompts install --node <path>/);
  assert.match(pickNode({ execPath, candidates: [], majorOf }).warning, /No system-wide Node\.js was found/);
  // A system-wide Node.js without node:sqlite is still used, with a warning about T3 Code.
  const sqliteOf = (file) => file === execPath;
  assert.match(pickNode({ execPath, candidates: [good], majorOf, sqliteOf }).warning, /cannot read T3 Code's database.*--node <path>/s);
  assert.equal(pickNode({ execPath, candidates: [good], majorOf, sqliteOf: () => true }).warning, null);
  assert.equal(pickNode({ execPath, candidates: [good], majorOf, sqliteOf: () => false }).warning, null);
});

test('installRuntime leaves a directory that is not a runtime copy, and fills an empty one', () => {
  const source = tempDir('open-prompts-source-');
  for (const [file, content] of [['bin/open-prompts', "import('../src/cli.mjs');\n"], ['package.json', '{"version":"9.9.9"}\n']]) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), content);
  }
  const dir = tempDir('open-prompts-data-');
  fs.writeFileSync(path.join(dir, 'important.txt'), 'keep');
  assert.throws(() => installRuntime(source, { OPEN_PROMPTS_DATA_DIR: dir }), /is not a copy of open-prompts made by install.*OPEN_PROMPTS_DATA_DIR/);
  assert.deepEqual(fs.readdirSync(dir), ['important.txt']);
  assert.deepEqual(fs.readdirSync(path.dirname(dir)).filter((name) => name.includes(path.basename(dir)) && name !== path.basename(dir)), [], 'no temporary directory is left');
  const empty = tempDir('open-prompts-data-');
  assert.equal(installRuntime(source, { OPEN_PROMPTS_DATA_DIR: empty }).copied, true);
  assert.ok(fs.existsSync(path.join(empty, 'bin', 'open-prompts')));
});

test('installed paths are read back for every agent, and gone ones are reported', () =>
  withHome((home, env) => {
    const bin = tempDir('open-prompts-bin-');
    const live = { nodePath: process.execPath, scriptPath: path.join(bin, "it's here", 'bin', 'open-prompts') };
    fs.mkdirSync(path.dirname(live.scriptPath), { recursive: true });
    fs.writeFileSync(live.scriptPath, '');
    fs.mkdirSync(path.join(bin, "it's here", 'src'));
    fs.writeFileSync(path.join(bin, "it's here", 'src', 'opencode-plugin.mjs'), '');
    for (const agent of AGENTS) {
      installAgent(agent, { ...live, env });
      const expected = agent === 'opencode' ? [{ nodePath: null, scriptPath: path.join(bin, "it's here", 'src', 'opencode-plugin.mjs') }] : [live];
      const found = installedPaths(agent, env);
      assert.deepEqual(agent === 'claude-code' ? found.slice(0, 1) : found, expected, agent);
      assert.deepEqual(missingPaths(agent, env), [], agent);
      installAgent(agent, { ...paths, env });
      const gone = agent === 'opencode' ? ['/opt/open-prompts/src/opencode-plugin.mjs'] : [paths.nodePath, paths.scriptPath].filter((file) => !fs.existsSync(file));
      assert.deepEqual(missingPaths(agent, env), gone, agent);
    }
  }));

test('a new install replaces the entries that pointed to an old copy', () =>
  withHome((home, env) => {
    const before = { nodePath: '/Users/jane/.nvm/versions/node/v20.0.0/bin/node', scriptPath: '/Users/jane/code/app/node_modules/@open-prompts/cli/bin/open-prompts' };
    const after = { nodePath: '/usr/bin/node', scriptPath: path.join(home, '.local', 'share', 'open-prompts', 'bin', 'open-prompts') };
    for (const agent of AGENTS) {
      installAgent(agent, { ...before, env });
      installAgent(agent, { ...after, env });
      const found = installedPaths(agent, env);
      if (agent === 'opencode') assert.deepEqual(found, [{ nodePath: null, scriptPath: path.join(home, '.local', 'share', 'open-prompts', 'src', 'opencode-plugin.mjs') }]);
      else if (agent === 'claude-code') assert.ok(found.length === 3 && found.every((entry) => entry.nodePath === after.nodePath && entry.scriptPath === after.scriptPath), agent);
      else assert.deepEqual(found, [after], agent);
    }
  }));
