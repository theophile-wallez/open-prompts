// Host markup, messages no person typed, extension fields and the "ignore" options.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { extractPrompts, handle as claudeHook } from '../src/agents/claude-code.mjs';
import * as codex from '../src/agents/codex.mjs';
import * as gemini from '../src/agents/gemini-cli.mjs';
import * as vibe from '../src/agents/vibe.mjs';
import { cleanHostMarkup, isHostAutomated, isHostSession, writePrompt } from '../src/core.mjs';
import { findProject, readConfig } from '../src/project.mjs';
import { makeRecord } from '../src/record.mjs';
import { importFile, optedInRepo, readJsonl, tempDir } from './helpers.mjs';

const NOW = new Date('2026-11-20T15:48:02.123Z');
const ATTACHMENT = 'aa11bb22-3c4d-4e5f-8a9b-0c1d2e3f4a5b-66778899-aabb-4ccd-8eef-001122334455';

/** A context block as T3 Code writes it after a message with an attached image. */
const imageContext = (id, attachment = ATTACHMENT) =>
  `<t3_context version="1">\n<context kind="image" id="${id}">\nname: image.png\nmimeType: image/png\nsizeBytes: 30742\nattachmentId: ${attachment}\n</context>\n</t3_context>`;
const attachedImage = (attachment = ATTACHMENT) => `[Attached image "image.png" is saved at: /Users/jane/.t3/userdata/attachments/${attachment}.png]`;

test('an image T3 Code writes in two forms leaves one [image] and no local path', () => {
  const raw = `does this look right? [Image: image.png; ref=image_7e7e1111] the key is random\n\n${imageContext('image_7e7e1111')}\n\n${attachedImage()}`;
  assert.equal(cleanHostMarkup(raw), 'does this look right? [image] the key is random');
});

test('an attached image without an inline reference becomes [image]', () => {
  assert.equal(cleanHostMarkup(`look at this\n\n${attachedImage()}`), 'look at this\n\n[image]');
  assert.equal(cleanHostMarkup(`two shots\n\n${attachedImage('a1')}\n\n${attachedImage('b2')}`), 'two shots\n\n[image]\n\n[image]');
});

test('inline references and attached lines are paired by count when no context block names them', () => {
  const raw = `before ![image.png](t3-context://v1/image/image_7e7e2222) after\n\n${attachedImage('other-id')}`;
  assert.equal(cleanHostMarkup(raw), 'before [image] after');
});

test('attached files become [file]', () => {
  const raw = `read this [File: notes.txt; ref=file_f00d001]\n\n<t3_context version="1">\n<context kind="file" id="file_f00d001">\nname: notes.txt\nattachmentId: f00d0002-txt\n</context>\n</t3_context>\n\n[Attached file "notes.txt" is saved at: /Users/jane/.t3/userdata/attachments/f00d0002-txt.txt]`;
  assert.equal(cleanHostMarkup(raw), 'read this [file]');
  assert.equal(cleanHostMarkup('[Attached file "notes.txt" is saved at: /Users/jane/.t3/userdata/attachments/x.txt]'), '[file]');
  assert.equal(cleanHostMarkup('see [notes.txt](t3-context://v1/file/file_f00d001)'), 'see [file]');
});

test('the database form of an image becomes [image]', () => {
  assert.equal(cleanHostMarkup('in the player ![image.png](t3-context://v1/image/image_7e7e3333) please'), 'in the player [image] please');
  assert.equal(cleanHostMarkup('quoted [Image: image.png] here'), 'quoted [image] here');
});

test('a reference to another thread keeps its title', () => {
  const raw = `does [Thread: Settings page; ref=thread_abcd1234] use routing?\n\n<t3_context version="1">\n<context kind="thread" id="thread_abcd1234">\ntitle: Settings page\nthreadId: abcd1234\n</context>\n</t3_context>`;
  assert.equal(cleanHostMarkup(raw), 'does [thread: Settings page] use routing?');
  assert.equal(cleanHostMarkup('does [Settings page](t3-context://v1/thread/thread_abcd1234) use routing?'), 'does [thread: Settings page] use routing?');
});

test('a message with attachments and no text is empty', () => {
  const raw = `[User attached one or more files without additional text. Respond using the conversation context and the attached files.]\n\n${attachedImage()}`;
  assert.equal(cleanHostMarkup(raw), '[image]');
  const { project } = { project: findProject(optedInRepo().root) };
  assert.deepEqual(writePrompt(project, { agent: 'codex', session: 's', prompt: cleanHostMarkup(raw) }), { action: 'ignored', reason: 'empty prompt' });
  assert.deepEqual(writePrompt(project, { agent: 'codex', session: 's', prompt: '[image] [thread: x]\n[file]' }), { action: 'ignored', reason: 'empty prompt' });
  // T3 Code writes "images" instead of "files" when only images are attached.
  const images = `[Image: image.png; ref=image_7e7e4444]\n\n[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]\n\n${attachedImage()}`;
  assert.equal(cleanHostMarkup(images), '[image]');
  assert.deepEqual(writePrompt(project, { agent: 'codex', session: 's', prompt: cleanHostMarkup(images) }), { action: 'ignored', reason: 'empty prompt' });
});

test('a quote link becomes a Markdown quote followed by the comment', () => {
  const link = `t3-citation://v1/env/thread/message%3Aabc?text=Only+Claude+Code%0Ais+supported.&start=1&end=30&prefix=x&suffix=y&comment=Can+you+support+the+others%3F`;
  assert.equal(cleanHostMarkup(`[Assistant quote](${link})`), '> Only Claude Code\n> is supported.\n\nCan you support the others?');
  assert.equal(cleanHostMarkup(`[Assistant quote](${link})\n\nand also this`), '> Only Claude Code\n> is supported.\n\nCan you support the others?\n\nand also this');
  assert.equal(cleanHostMarkup('[Assistant quote](t3-citation://v1/a/b?text=just+the+quote)'), '> just the quote');
});

test("T3 Code's thinking prefix and attachment metadata are removed", () => {
  assert.equal(cleanHostMarkup('Ultrathink: plan the migration'), 'plan the migration');
  assert.equal(cleanHostMarkup('we talked about Ultrathink: keep it'), 'we talked about Ultrathink: keep it');
  assert.equal(cleanHostMarkup('fix it ![image.png](t3-context://v1/image/image_1)\n\nAttachment metadata:\n- image.png (image/png, 161391 bytes)'), 'fix it [image]');
  assert.equal(cleanHostMarkup('Attachment metadata: is a field name'), 'Attachment metadata: is a field name');
});

test('text without host markup is left as typed', () => {
  for (const text of ['see [1] in the list', '![logo](./logo.png) in the README', 'the [Image: tag] in our docs is wrong]', 'a\n\n\nb'.replace(/\n{3}/, '\n\n')]) {
    assert.equal(cleanHostMarkup(text), text.trim());
  }
});

test('known agent-to-agent messages are automated', () => {
  const automated = [
    'Act as the implementation sub-agent for this task.\n\nFix the login page.',
    'Act as the research sub-agent for this task.\n\nInventory only.',
    'You take over a long job from a previous session: writing the docs.',
    'Delegated task node:delegated-task:command%3Amcp%3A0a0b0c0d finished.',
    'Note: the T3 server restarted, and this background work was cancelled.',
    'From session 1a2b3c4d (Game Review fixes): I am taking the preview.',
    'From 1a2b3c4d-5e6f (t3/branch): the user is reviewing my draft.',
    'From the session 1a2b3c4d (sidebar): done.',
    'From thread 1a2b3c4d (rows): pushed.',
    'From session mcp:1a2b3c4d (coordinate): ok.',
    'Note from another session (no reply needed): main now has 1234abc.',
    "Message d'une autre session (à la demande de l'utilisateur) : analyse",
    'FYI from the /ci-publish session (1a2b3c4d): main is red.',
    'Chrome no longer shows your draft "Settings page": session 1a2b took the preview.',
    "Chrome won't show your draft \"Nav\" any more.",
    'Chrome ne montre plus ton brouillon (« Légende ») : la session a pris la preview.',
    "Chrome n'affiche plus ton brouillon : la session 1a2b3c4d l'a prise.",
    'Continue where you left off. Your last turn was cut short, so a command may not have finished.',
    'Update on pull request #3 (https://github.com/o/r/pull/3), which T3 Code is watching for you:\n- Checks passed.',
    'You generate concise git branch names.\nReturn a JSON object with key: branch.',
  ];
  for (const text of automated) assert.equal(isHostAutomated(text), true, text);
  const typed = [
    "From the frame/shot, i'd like a small button in the player",
    'From now on, use tabs',
    'Continue where you left off. Then add tests for the parser.',
    // People type the short form too; under T3 Code, its database tells them apart.
    'Continue where you left off.',
    'From 20240101 to 20241231: count the rows per day',
    'From 1000000000 rows: which are dupes?',
    'continue',
    'Act as a reviewer and read my diff',
    'Chrome shows a blank page on /login',
    'Note from the meeting: ship on Friday',
    'FYI from now on we use pnpm',
    'Delegated task results look wrong, check them',
    'Update on pull request #3: please rebase',
  ];
  for (const text of typed) assert.equal(isHostAutomated(text), false, text);
});

test('agent-to-agent messages are recognized inside the wrapper T3 Code gives Gemini CLI', () => {
  const wrapped = (text) => `<t3_code_instructions>\nBe brief.\n</t3_code_instructions>\n<user_request>\n${text}\n</user_request>`;
  assert.equal(isHostAutomated(wrapped('Note from another session: please rebase')), true);
  assert.equal(isHostAutomated(wrapped('please rebase')), false);
});

test("the Gemini CLI hook skips an agent's message inside T3 Code's wrapper", async () => {
  const { root, env } = optedInRepo();
  const prompt = '<t3_code_instructions>\nBe brief.\n</t3_code_instructions>\n<user_request>\nNote from another session: please rebase\n</user_request>';
  assert.deepEqual(await gemini.handle({ hook_event_name: 'BeforeAgent', session_id: 's1', cwd: root, prompt }, { env, now: NOW }), { action: 'ignored', reason: 'automated message' });
});

test('host sessions are recognized by their first prompt', () => {
  assert.equal(isHostSession('You generate concise git branch names.\nRules: …'), true);
  assert.equal(isHostSession('Generate a title that will help the user recognize this T3 Code thread weeks later.'), true);
  assert.equal(isHostSession('Generate a title for my blog post'), false);
});

test('the hook ignores every prompt of a session T3 Code runs to name a branch', async () => {
  const { root, env, state } = optedInRepo();
  const submit = (prompt) => claudeHook({ hook_event_name: 'UserPromptSubmit', session_id: 'branch-namer', cwd: root, transcript_path: '', prompt }, { env, now: NOW });
  assert.deepEqual(await submit('You generate concise git branch names.\nReturn a JSON object with key: branch.'), { action: 'ignored', reason: 'session run by the host' });
  assert.deepEqual(await submit('fix the login page'), { action: 'ignored', reason: 'session run by the host' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'sessions', 'branch-namer.json'), 'utf8')).host_session, true);
  const other = await claudeHook({ hook_event_name: 'UserPromptSubmit', session_id: 'person', cwd: root, transcript_path: '', prompt: 'fix the login page' }, { env, now: NOW });
  assert.equal(other.action, 'recorded');
});

test('import skips a whole session T3 Code ran to name a branch, and agent messages in others', () => {
  const user = (promptId, content) => ({ type: 'user', sessionId: 's1', promptId, timestamp: '2026-11-20T10:00:00Z', message: { role: 'user', content } });
  assert.deepEqual(extractPrompts([user('p1', 'You generate concise git branch names.\nRules: short.'), user('p2', 'something else')]), []);
  const prompts = extractPrompts([
    user('p1', 'Add a login page'),
    user('p2', 'Chrome no longer shows your draft "Login": session 1a2b3c4d took the preview.'),
    user('p3', 'Delegated task node:delegated-task:abc finished'),
    user('p4', 'You generate concise git branch names.'),
    user('p5', 'Thanks'),
  ]);
  assert.deepEqual(
    prompts.map((prompt) => prompt.prompt),
    ['Add a login page', 'Thanks'],
    'a branch-namer prompt in the middle of a session is skipped alone',
  );
});

test('makeRecord writes extension fields after the fields of the spec', () => {
  const record = makeRecord({ agent: 'claude-code', session: 's', timestamp: '2026-11-20T10:00:00Z', prompt: 'p', extensions: { x_thread: 't-1', x_host: 't3', other: 1, x_none: undefined } });
  assert.deepEqual(Object.keys(record), ['v', 'timestamp', 'agent', 'agent_version', 'model', 'session', 'prompt', 'x_thread', 'x_host']);
  assert.equal(record.x_host, 't3');
});

function configFile(config) {
  const file = path.join(tempDir(), '.open-prompts.json');
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

test('readConfig reads "ignore" and "ignoreCommands"', () => {
  const config = readConfig(configFile({ version: 1, ignore: ['^wip$', '/^draft:/i'], ignoreCommands: ['/clear', '/compact'] }));
  assert.deepEqual(config.ignore, [/^wip$/, /^draft:/i]);
  assert.deepEqual(config.ignoreCommands, ['/clear', '/compact']);
  assert.deepEqual(readConfig(configFile({ version: 1, ignore: ['/x/gi'] })).ignore, [/x/i], '"g" is dropped so test() has no state');
});

test('readConfig explains invalid "ignore" and "ignoreCommands"', () => {
  assert.throws(() => readConfig(configFile({ version: 1, ignore: '^wip$' })), /"ignore" must be a list of regular expressions/);
  assert.throws(() => readConfig(configFile({ version: 1, ignore: ['ok', 3] })), /"ignore\[1\]" must be a non-empty string/);
  assert.throws(() => readConfig(configFile({ version: 1, ignore: ['(unclosed'] })), /"ignore\[0\]" is not a valid regular expression/);
  assert.throws(() => readConfig(configFile({ version: 1, ignoreCommands: '/clear' })), /"ignoreCommands" must be a list of slash commands/);
  assert.throws(() => readConfig(configFile({ version: 1, ignoreCommands: ['clear'] })), /"ignoreCommands\[0\]" must be a slash command/);
  assert.throws(() => readConfig(configFile({ version: 1, ignoreCommands: ['/model opus'] })), /"ignoreCommands\[0\]" must be a slash command/);
});

function repoWith(options) {
  const repo = optedInRepo();
  fs.writeFileSync(path.join(repo.root, '.open-prompts.json'), JSON.stringify({ version: 1, dir: 'prompts', ...options }));
  return { ...repo, project: findProject(repo.root) };
}

test('writePrompt skips the commands and patterns a project lists', () => {
  const { project } = repoWith({ ignoreCommands: ['/compact', '/model'], ignore: ['^(ok|thanks)$', '/^wip\\b/i'] });
  const write = (prompt) => writePrompt(project, { agent: 'codex', session: 's-1', timestamp: '2026-11-20T10:00:00Z', prompt });
  assert.equal(write('/compact').action, 'ignored');
  assert.equal(write('/compact keep the API notes').reason, '/compact is in "ignoreCommands"');
  assert.equal(write('/model claude-opus-5-5').action, 'ignored');
  assert.equal(write('/compactor').action, 'recorded', 'only the exact command');
  assert.equal(write('please /compact later').action, 'recorded');
  assert.equal(write('ok').reason, 'matches "ignore" pattern /^(ok|thanks)$/');
  assert.equal(write('WIP: nothing yet').action, 'ignored');
  assert.equal(write('ok, now add tests').action, 'recorded');
});

test('slash commands are recorded when the project lists none', () => {
  const { project } = repoWith({});
  assert.equal(writePrompt(project, { agent: 'codex', session: 's-1', prompt: '/compact' }).action, 'recorded');
});

test('hooks and import honor the ignore options', async () => {
  const { root, env, project, promptsDir } = repoWith({ ignoreCommands: ['/clear'], ignore: ['^ok$'] });
  const hook = await claudeHook({ hook_event_name: 'UserPromptSubmit', session_id: 's-1', cwd: root, transcript_path: '', prompt: '/clear' }, { env, now: NOW });
  assert.equal(hook.action, 'ignored');
  const codexResult = await codex.handle({ hook_event_name: 'UserPromptSubmit', turn_id: 't', session_id: 's-2', cwd: root, prompt: 'ok' }, { env, now: NOW });
  assert.equal(codexResult.action, 'ignored');
  const deferred = await vibe.handle({ hook_event_name: 'pre_agent', session_id: 's-3', cwd: root, prompt: '/clear' }, { env, now: NOW });
  assert.equal(deferred.action, 'ignored', 'no pending file for a prompt the project leaves out');

  const transcript = path.join(tempDir(), 's-4.jsonl');
  const entry = (promptId, content) => JSON.stringify({ type: 'user', sessionId: 's-4', promptId, timestamp: '2026-11-20T10:00:00Z', message: { role: 'user', content } });
  fs.writeFileSync(transcript, [entry('p1', '<command-name>/clear</command-name>\n<command-args></command-args>'), entry('p2', 'ok'), entry('p3', 'Add a login page')].join('\n') + '\n');
  const result = await importFile(project, transcript);
  assert.equal(result.written, 1);
  assert.equal(result.ignored, 2);
  assert.deepEqual(readJsonl(result.files[0]).map((record) => record.prompt), ['Add a login page']);
  assert.equal(fs.readdirSync(promptsDir).length, 1);
});
