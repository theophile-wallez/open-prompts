import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as gemini from '../src/agents/gemini-cli.mjs';
import { writePrompt } from '../src/core.mjs';
import { findProject, readConfig } from '../src/project.mjs';
import { optedInRepo, readJsonl, tempDir } from './helpers.mjs';

function configFile(config) {
  const file = path.join(tempDir(), '.open-prompts.json');
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

test('readConfig fills in the redaction defaults and ignores unknown fields', () => {
  assert.deepEqual(readConfig(configFile({ version: 1 })), { version: 1, dir: 'prompts', redact: { emails: false, homePaths: true }, ignore: [], ignoreCommands: [], spool: true, maxPasteLength: null });
  assert.deepEqual(readConfig(configFile({ version: 1, dir: 'p', redact: { emails: true, homePaths: false, later: 1 }, x_other: true, spool: false, maxPasteLength: 4000 })), {
    version: 1,
    dir: 'p',
    redact: { emails: true, homePaths: false },
    ignore: [],
    ignoreCommands: [],
    spool: false,
    maxPasteLength: 4000,
  });
  assert.equal(readConfig(configFile({ version: 1, maxPasteLength: false })).maxPasteLength, null);
});

test('readConfig explains invalid redaction options', () => {
  assert.throws(() => readConfig(configFile({ version: 1, redact: true })), /"redact" must be an object/);
  assert.throws(() => readConfig(configFile({ version: 1, redact: [] })), /"redact" must be an object/);
  assert.throws(() => readConfig(configFile({ version: 1, redact: { emails: 'yes' } })), /"redact\.emails" must be true or false/);
  assert.throws(() => readConfig(configFile({ version: 1, redact: { homePaths: 0 } })), /"redact\.homePaths" must be true or false/);
  assert.throws(() => readConfig(configFile({ version: 1, spool: 'no' })), /"spool" must be true or false/);
  for (const value of ['4000', 99, 1000.5, -1, true]) {
    assert.throws(() => readConfig(configFile({ version: 1, maxPasteLength: value })), /"maxPasteLength" must be a whole number of characters, 100 or more/);
  }
});

function repoWith(redact) {
  const repo = optedInRepo();
  fs.writeFileSync(path.join(repo.root, '.open-prompts.json'), JSON.stringify({ version: 1, dir: 'prompts', redact }));
  return { ...repo, project: findProject(repo.root) };
}

const prompt = 'ask jane.doe@example.com about /Users/janedoe/app';

test('writePrompt uses the redaction options of the project', () => {
  const defaults = repoWith(undefined);
  const result = writePrompt(defaults.project, { agent: 'codex', session: 's-1', timestamp: '2026-11-20T10:00:00Z', prompt });
  assert.equal(result.record.prompt, 'ask jane.doe@example.com about ~/app');
  assert.equal(result.homePaths, 1);

  const custom = repoWith({ emails: true, homePaths: false });
  const other = writePrompt(custom.project, { agent: 'codex', session: 's-1', timestamp: '2026-11-20T10:00:00Z', prompt });
  assert.equal(other.record.prompt, 'ask [REDACTED:email] about /Users/janedoe/app');
  assert.deepEqual(other.redacted, ['email']);
  assert.equal(readJsonl(other.file)[0].prompt, other.record.prompt);
});

test('adapters that redact before the background step use the project options too', async () => {
  const { root, env } = repoWith({ emails: true });
  const { payload } = await gemini.handle({ hook_event_name: 'BeforeAgent', session_id: 'g', cwd: root, transcript_path: '', prompt }, { env });
  assert.equal(payload.prompt, 'ask [REDACTED:email] about ~/app', 'the pending file holds no email either');
});
