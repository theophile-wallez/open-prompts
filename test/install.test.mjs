import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { AGENTS, configPath, detectInstalledAgents, installAgent, isAgentInstalled, uninstallAgent } from '../src/install.mjs';
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
