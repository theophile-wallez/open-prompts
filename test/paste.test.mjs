import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { extractPrompts, handle as handleHook, splitPastes } from '../src/agents/claude-code.mjs';
import { reconcile } from '../src/backfill.mjs';
import { writePrompt } from '../src/core.mjs';
import { limitPastes, shortenPaste } from '../src/paste.mjs';
import { findProject } from '../src/project.mjs';
import { optedInRepo, readJsonl } from './helpers.mjs';

const SESSION = '234908e6-56a5-49e3-b055-a161f39d736f';
const NOW = new Date('2026-11-20T15:48:02.123Z');

/** A Playwright-like log of `count` lines. */
const playwrightLog = (count) => Array.from({ length: count }, (_, i) => `  [chromium] › login.spec.ts:${i + 1}:3 › step ${i} passed (${i}ms)`).join('\n');

function repoWith(config) {
  const repo = optedInRepo();
  fs.writeFileSync(path.join(repo.root, '.open-prompts.json'), JSON.stringify({ version: 1, dir: 'prompts', ...config }));
  return { ...repo, project: findProject(repo.root) };
}

test('shortenPaste keeps the first and last lines within the limit and says how many were left out', () => {
  const log = playwrightLog(300);
  const lines = log.split('\n');
  const short = shortenPaste(log, 1000);
  assert.ok(short.length <= 1000, `${short.length} characters`);
  const kept = short.split('\n');
  const marker = kept.findIndex((line) => line.startsWith('[…'));
  assert.deepEqual(kept.slice(0, marker), lines.slice(0, marker), 'the first lines are kept whole');
  assert.deepEqual(kept.slice(marker + 1), lines.slice(lines.length - (kept.length - marker - 1)), 'the last lines are kept whole');
  assert.equal(kept[marker], `[… ${lines.length - kept.length + 1} lines omitted …]`);
  assert.ok(marker >= 3 && kept.length - marker - 1 >= 3, 'both ends keep several lines');
  assert.equal(shortenPaste(log, log.length), log, 'text within the limit is kept as it is');
  assert.equal(shortenPaste('a\nb', 100), 'a\nb');
});

test('shortenPaste cuts one long line between words, and never keeps part of a private key', () => {
  const line = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
  const short = shortenPaste(line, 200);
  assert.ok(short.length <= 200);
  assert.match(short, /^word0 word1 .* \[… \d+ characters omitted …\] .* word399$/);
  for (const word of short.split(' ').filter((word) => word.startsWith('word'))) assert.match(word, /^word\d+$/, 'no word is cut in half');
  assert.equal(shortenPaste('x'.repeat(5000), 200), '[… 5000 characters omitted …]', 'a single token is left out whole');

  const key = ['-----BEGIN RSA PRIVATE KEY-----', ...Array(60).fill('MIIEowIBAAKCAQEAyPyqmBd7Hn1Lm8tJm2Xb'), '-----END RSA PRIVATE KEY-----'];
  const pasted = ['deploy key below', ...key, 'thanks'].join('\n');
  const cut = shortenPaste(pasted, 400);
  assert.doesNotMatch(cut, /MIIE|PRIVATE KEY/, 'a key cut by the limit would escape redaction, so it goes whole');
  assert.match(cut, /^deploy key below\n\[… 62 lines omitted …\]\nthanks$/);
});

test('limitPastes shortens only the marked blocks, or the whole prompt when nothing is marked', () => {
  const log = playwrightLog(200);
  const prompt = `why does this fail?\n${log}\nand this one is short:\nok`;
  const marked = limitPastes(prompt, [log, 'ok'], 500);
  assert.equal(marked.shortened, 1);
  assert.match(marked.text, /^why does this fail\?\n {2}\[chromium\]/);
  assert.match(marked.text, /\[… \d+ lines omitted …\]/);
  assert.match(marked.text, /\nand this one is short:\nok$/, 'typed text around the block is kept');

  const typed = 'x '.repeat(400);
  assert.deepEqual(limitPastes(typed, [], 500), { text: typed, shortened: 0 }, 'with markers, typed text is never shortened');
  const whole = limitPastes(prompt, undefined, 500);
  assert.equal(whole.shortened, 1);
  assert.ok(whole.text.length <= 500);
  assert.match(whole.text, /^why does this fail\?\n/);
  assert.deepEqual(limitPastes(prompt, undefined, null), { text: prompt, shortened: 0 }, 'off by default');
});

test('splitPastes lists the pasted blocks Claude Code marks, and removes the markers', () => {
  const raw = 'look:\n<pasted_content id="ab12">\nError: boom\n  at x.js:1\n</pasted_content id="ab12">\nwhy?';
  assert.deepEqual(splitPastes(raw), { prompt: 'look:\nError: boom\n  at x.js:1\nwhy?', pastes: ['Error: boom\n  at x.js:1'] });
  assert.deepEqual(splitPastes('typed only'), { prompt: 'typed only', pastes: undefined });
});

test('the Claude Code hook shortens a long paste when the repository sets maxPasteLength', async () => {
  const { root, env } = repoWith({ maxPasteLength: 1000 });
  const log = `${playwrightLog(400)}\n  token=ghp_abcdefghijklmnopqrstuvwxyz0123456789AB`;
  const prompt = `Fix the login test, here is the log:\n<pasted_content id="p1">\n${log}\n</pasted_content id="p1">\nIt started after the last merge.`;
  const result = await handleHook({ session_id: SESSION, cwd: root, transcript_path: '', hook_event_name: 'UserPromptSubmit', prompt }, { env, now: NOW });
  assert.equal(result.action, 'recorded');
  assert.equal(result.shortened, 1);
  const recorded = readJsonl(result.file)[0].prompt;
  assert.match(recorded, /^Fix the login test, here is the log:\n {2}\[chromium\] › login\.spec\.ts:1:3/);
  assert.match(recorded, /\n\[… \d+ lines omitted …\]\n/);
  assert.match(recorded, /token=\[REDACTED:github-token\]\nIt started after the last merge\.$/, 'the kept lines are still redacted');
  assert.ok(recorded.length < 1100);
});

test('without maxPasteLength, everything pasted is recorded', async () => {
  const { root, env } = repoWith({});
  const log = playwrightLog(400);
  const prompt = `see:\n<pasted_content>\n${log}\n</pasted_content>`;
  const result = await handleHook({ session_id: SESSION, cwd: root, transcript_path: '', hook_event_name: 'UserPromptSubmit', prompt }, { env, now: NOW });
  assert.equal(readJsonl(result.file)[0].prompt, `see:\n${log}`);
  assert.equal(result.shortened, undefined);
});

test('agents without paste markers get the whole prompt shortened, only past the limit', () => {
  const { project } = repoWith({ maxPasteLength: 2000 });
  const base = { agent: 'codex', session: 's-1', timestamp: '2026-11-20T10:00:00Z' };
  const long = writePrompt(project, { ...base, id: 'a', prompt: `the e2e run failed:\n${playwrightLog(500)}` });
  assert.equal(long.shortened, 1);
  assert.ok(long.record.prompt.length <= 2000);
  assert.match(long.record.prompt, /^the e2e run failed:\n/);
  const short = writePrompt(project, { ...base, id: 'b', prompt: 'a short prompt' });
  assert.equal(short.record.prompt, 'a short prompt');
  assert.equal(short.shortened, undefined);
});

test('import sees a prompt the hook shortened as already there', () => {
  const { project } = repoWith({ maxPasteLength: 100 });
  // With so small a limit, no line of the log fits: the record starts with the marker, unlike the full text.
  const prompt = `${playwrightLog(300)}\nwhat broke?`;
  const hook = writePrompt(project, { agent: 'codex', session: 's-1', timestamp: '2026-11-20T10:00:00Z', prompt });
  const candidate = { source: 'codex', agent: 'codex', session: 's-1', timestamp: '2026-11-20T10:00:00.500Z', prompt, automated: null };
  assert.match(hook.record.prompt, /^\[… \d+ lines omitted …\]\n.*\nwhat broke\?$/);
  const { write, duplicates } = reconcile([candidate], { existing: [hook.record], project });
  assert.deepEqual(write, []);
  assert.equal(duplicates, 1);
});

test('extractPrompts keeps the pasted blocks of a transcript, for maxPasteLength', () => {
  const entries = [
    { type: 'user', sessionId: SESSION, promptId: 'p1', timestamp: '2026-11-20T10:00:00Z', message: { role: 'user', content: 'see:\n<pasted_content>\nlog line\n</pasted_content>' } },
    { type: 'user', sessionId: SESSION, promptId: 'p2', timestamp: '2026-11-20T10:01:00Z', message: { role: 'user', content: 'typed' } },
  ];
  const [first, second] = extractPrompts(entries);
  assert.deepEqual(first.pastes, ['log line']);
  assert.equal('pastes' in second, false);
});
