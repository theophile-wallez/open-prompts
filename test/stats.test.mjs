import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatStats, promptStats } from '../src/stats.mjs';
import { tempDir } from './helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/open-prompts', import.meta.url));

const record = (session, timestamp, agent, model, prompt = 'x') => ({ v: 1, timestamp, agent, agent_version: null, model, session, prompt });

const RECORDS = [
  record('aaaa1111-session', '2026-11-20T09:00:00Z', 'claude-code', 'claude-opus-5-5'),
  record('aaaa1111-session', '2026-11-20T09:05:00Z', 'claude-code', 'claude-opus-5-5'),
  record('aaaa1111-session', '2026-11-21T08:00:00Z', 'claude-code', 'claude-sonnet-5-5'),
  record('ses_codex', '2026-11-21T23:30:00-02:00', 'codex', 'gpt-5.5-codex'),
  record('ses_codex', '2026-11-22T10:00:00Z', 'codex', null),
];

test('promptStats counts prompts per day, model, session and agent', () => {
  const stats = promptStats(RECORDS);
  assert.equal(stats.prompts, 5);
  assert.equal(stats.sessions, 2);
  assert.equal(stats.first, '2026-11-20');
  assert.equal(stats.last, '2026-11-22');
  assert.deepEqual(stats.by.day, [
    { day: '2026-11-20', prompts: 2 },
    { day: '2026-11-21', prompts: 1 },
    { day: '2026-11-22', prompts: 2 },
  ], 'days are UTC days, in order of time');
  assert.deepEqual(stats.by.model, [
    { model: 'claude-opus-5-5', prompts: 2 },
    { model: 'claude-sonnet-5-5', prompts: 1 },
    { model: 'gpt-5.5-codex', prompts: 1 },
    { model: null, prompts: 1 },
  ]);
  assert.deepEqual(stats.by.session, [
    { session: 'aaaa1111-session', first: '2026-11-20T09:00:00.000Z', agent: 'claude-code', prompts: 3 },
    { session: 'ses_codex', first: '2026-11-22T01:30:00.000Z', agent: 'codex', prompts: 2 },
  ]);
  assert.deepEqual(stats.by.agent, [
    { agent: 'claude-code', prompts: 3 },
    { agent: 'codex', prompts: 2 },
  ]);
  assert.deepEqual(Object.keys(promptStats(RECORDS, { by: ['agent', 'day'] }).by), ['day', 'agent']);
});

test('formatStats aligns the columns', () => {
  const text = formatStats(promptStats(RECORDS, { by: ['model', 'session'] }));
  assert.equal(
    text,
    [
      '5 prompts in 2 sessions, from 2026-11-20 to 2026-11-22.',
      '',
      'By model',
      '  model              prompts  share',
      '  claude-opus-5-5          2    40%',
      '  claude-sonnet-5-5        1    20%',
      '  gpt-5.5-codex            1    20%',
      '  unknown model            1    20%',
      '',
      'By session',
      '  first day   session           agent        prompts',
      '  2026-11-20  aaaa1111-session  claude-code        3',
      '  2026-11-22  ses_codex         codex              2',
    ].join('\n'),
  );
  assert.equal(formatStats(promptStats([])), 'No prompts recorded yet.');
});

test('open-prompts stats reads the prompt files, with --by and --json', () => {
  const repo = tempDir();
  fs.mkdirSync(path.join(repo, '.git'));
  fs.writeFileSync(path.join(repo, '.open-prompts.json'), JSON.stringify({ version: 1 }));
  fs.mkdirSync(path.join(repo, 'prompts'));
  const write = (name, records) => fs.writeFileSync(path.join(repo, 'prompts', name), records.map((one) => `${JSON.stringify(one)}\n`).join(''));
  write('2026-11-20-aaaa1111.jsonl', RECORDS.slice(0, 3));
  write('2026-11-22-ses_code.jsonl', RECORDS.slice(3));
  const env = { ...process.env, OPEN_PROMPTS_STATE_DIR: tempDir() };
  const run = (args) => spawnSync(process.execPath, [BIN, 'stats', ...args], { cwd: repo, env, encoding: 'utf8' });

  const all = run([]);
  assert.equal(all.status, 0, all.stderr);
  for (const title of ['By day', 'By model', 'By session', 'By agent']) assert.match(all.stdout, new RegExp(`^${title}$`, 'm'));

  const json = run(['--by', 'agent', '--json']);
  assert.deepEqual(JSON.parse(json.stdout), { prompts: 5, sessions: 2, first: '2026-11-20', last: '2026-11-22', by: { agent: [{ agent: 'claude-code', prompts: 3 }, { agent: 'codex', prompts: 2 }] } });
  assert.deepEqual(Object.keys(JSON.parse(run(['--by=day,model', '--json']).stdout).by), ['day', 'model']);

  const wrong = run(['--by', 'week']);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /Unknown group "week" for --by\. Groups: day, model, session, agent\./);

  const outside = spawnSync(process.execPath, [BIN, 'stats'], { cwd: tempDir(), env, encoding: 'utf8' });
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /has not opted in/);
});
