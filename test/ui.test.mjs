import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { findProject } from '../src/project.mjs';
import { rewriteLine } from '../src/store.mjs';
import { startServer } from '../src/ui/server.mjs';
import { optedInRepo, readJsonl, tempDir } from './helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/open-prompts', import.meta.url));

const record = (session, n, prompt) =>
  JSON.stringify({ v: 1, id: `${session}-${n}`, timestamp: `2026-11-20T10:0${n}:00.000Z`, agent: 'claude-code', agent_version: '2.1.0', model: 'claude-opus-5-5', session, prompt });

async function setup(t) {
  const repo = optedInRepo();
  fs.mkdirSync(repo.promptsDir);
  const file = path.join(repo.promptsDir, '2026-11-20-aaaa1111.jsonl');
  fs.writeFileSync(file, `${record('aaaa1111-x', 1, 'First prompt')}\n${record('aaaa1111-x', 2, 'Use GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789AB')}\n`);
  const env = { ...process.env, ...repo.env, OPEN_PROMPTS: '' };
  const ui = await startServer(findProject(repo.root), { env });
  t.after(() => ui.close());
  const base = `http://127.0.0.1:${ui.port}`;
  const login = await fetch(ui.url, { redirect: 'manual' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = (method, url, body, headers = {}) =>
    fetch(base + url, {
      method,
      headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  const data = async () => (await call('GET', '/api/data')).json();
  return { ...repo, ui, base, call, data, file, login };
}

test('the page and the API need the token from the printed link', async (t) => {
  const { base, ui, call, login } = await setup(t);
  assert.equal(login.status, 303);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(`${base}/`)).status, 403);
  assert.equal((await fetch(`${base}/api/data`)).status, 403);
  assert.equal((await fetch(`${base}/?token=wrong`, { redirect: 'manual' })).status, 403);
  assert.equal((await call('GET', '/')).status, 200);
  assert.match(await (await call('GET', '/app.js')).text(), /EventSource/);
  const font = await call('GET', '/fonts/AlloVariableFriendly.woff2');
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.ok(ui.url.startsWith('http://127.0.0.1:'));
});

test('requests addressed to another host name or from another origin are refused', async (t) => {
  const { call, ui, login } = await setup(t);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: ui.port, path: '/api/data', headers: { host: 'evil.example', cookie } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
  const response = await call('DELETE', '/api/session', { file: '2026-11-20-aaaa1111.jsonl' }, { origin: 'https://evil.example' });
  assert.equal(response.status, 403);
});

test('lists prompts and sessions', async (t) => {
  const { data } = await setup(t);
  const result = await data();
  assert.equal(result.prompts.length, 2);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].count, 2);
  assert.deepEqual(result.sessions[0].models, ['claude-opus-5-5']);
  assert.equal(result.prompts[1].secrets, undefined, 'recording already redacts: the page does not scan again');
  assert.equal(result.recording, true);
  assert.deepEqual(result.problems, []);
});

test('edits a prompt in place, redacts it, and keeps the other fields', async (t) => {
  const { call, data, file } = await setup(t);
  const [, second] = (await data()).prompts;
  const response = await call('PATCH', '/api/prompt', { file: second.file, line: second.line, hash: second.hash, prompt: second.prompt });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).redacted, ['github-token']);
  const records = readJsonl(file);
  assert.equal(records[1].prompt, 'Use GITHUB_TOKEN=[REDACTED:github-token]');
  assert.equal(records[1].id, 'aaaa1111-x-2');
  assert.deepEqual(Object.keys(records[1]), ['v', 'id', 'timestamp', 'agent', 'agent_version', 'model', 'session', 'prompt']);
  assert.equal(records[0].prompt, 'First prompt');

  // The page still holds the old hash: the edit is refused instead of overwriting the new text.
  const stale = await call('PATCH', '/api/prompt', { file: second.file, line: second.line, hash: second.hash, prompt: 'Other' });
  assert.equal(stale.status, 409);

  const empty = await call('PATCH', '/api/prompt', { ...(await data()).prompts[0], prompt: '  ' });
  assert.equal(empty.status, 400);
});

test('deletes prompts, and the file with its last prompt', async (t) => {
  const { call, data, file } = await setup(t);
  const [first] = (await data()).prompts;
  assert.equal((await call('DELETE', '/api/prompt', first)).status, 200);
  assert.deepEqual(readJsonl(file).map((r) => r.id), ['aaaa1111-x-2']);
  const [remaining] = (await data()).prompts;
  assert.equal(remaining.line, 0);
  const last = await call('DELETE', '/api/prompt', remaining);
  assert.deepEqual(await last.json(), { removedFile: true });
  assert.equal(fs.existsSync(file), false);
});

test('deletes a session, and only files of the prompts directory', async (t) => {
  const { call, file, root } = await setup(t);
  fs.writeFileSync(path.join(root, 'outside.jsonl'), '{}\n');
  assert.equal((await call('DELETE', '/api/session', { file: '../outside.jsonl' })).status, 400);
  assert.equal((await call('DELETE', '/api/session', { file: 'missing.jsonl' })).status, 404);
  assert.ok(fs.existsSync(path.join(root, 'outside.jsonl')));
  assert.equal((await call('DELETE', '/api/session', { file: path.basename(file) })).status, 200);
  assert.equal(fs.existsSync(file), false);
});

test('pauses and resumes recording', async (t) => {
  const { call, state } = await setup(t);
  assert.deepEqual(await (await call('PUT', '/api/recording', { recording: false })).json(), { recording: false });
  assert.ok(fs.existsSync(path.join(state, 'paused')));
  assert.deepEqual(await (await call('PUT', '/api/recording', { recording: true })).json(), { recording: true });
  assert.equal(fs.existsSync(path.join(state, 'paused')), false);
});

test('rewriteLine refuses a line that changed', () => {
  const file = path.join(tempDir(), 'f.jsonl');
  fs.writeFileSync(file, 'a\nb\nc\n');
  assert.equal(rewriteLine(file, 1, 'x', 'B'), false);
  assert.equal(rewriteLine(file, 1, 'b', 'B'), true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'a\nB\nc\n');
  assert.equal(rewriteLine(file, 0, 'a', null), true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'B\nc\n');
});

test('"open-prompts ui" needs a repository that opted in', () => {
  const result = spawnSync(process.execPath, [BIN, 'ui', '--no-open'], { cwd: tempDir(), encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /has not opted in/);
});

test('finds the project icon the way T3 Code does', async () => {
  const { findProjectIcon, extractIconHref } = await import('../src/ui/project-icon.mjs');
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const project = () => fs.realpathSync(tempDir());
  const write = (root, rel, content = png) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };

  const none = project();
  assert.equal(findProjectIcon(none), null);

  const known = project();
  write(known, 'public/favicon.svg', '<svg/>');
  write(known, 'assets/logo.png');
  assert.equal(findProjectIcon(known), path.join(known, 'public/favicon.svg'));

  // t3.json wins over well-known files.
  write(known, 'brand/mark.png');
  write(known, 't3.json', JSON.stringify({ iconPath: 'brand/mark.png' }));
  assert.equal(findProjectIcon(known), path.join(known, 'brand/mark.png'));

  const html = project();
  write(html, 'index.html', '<head><link rel="stylesheet" href="/a.css"><link rel="icon" href="/static/app.png?v=2"></head>');
  write(html, 'public/static/app.png');
  assert.equal(findProjectIcon(html), path.join(html, 'public/static/app.png'));
  assert.equal(extractIconHref("links: [{ rel: 'icon', href: '/icon.svg' }]"), '/icon.svg');

  const extension = project();
  write(extension, 'src/manifest.json', JSON.stringify({ icons: { 16: 'icons/s.png', 128: 'icons/l.png' } }));
  write(extension, 'public/icons/s.png');
  write(extension, 'public/icons/l.png');
  assert.equal(findProjectIcon(extension), path.join(extension, 'public/icons/l.png'));

  // Nothing outside the project, and nothing a browser cannot show.
  const escape = project();
  write(escape, 't3.json', JSON.stringify({ iconPath: '../../etc/passwd.png' }));
  write(escape, 'Resources/AppIcon.icns');
  assert.equal(findProjectIcon(escape), null);
});

test('serves the project icon and names it in the data', async (t) => {
  const { call, data, root } = await setup(t);
  assert.equal((await data()).project.icon, null);
  assert.equal((await call('GET', '/project-icon')).status, 404);
  fs.writeFileSync(path.join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const { icon } = (await data()).project;
  assert.match(icon, /^\/project-icon\?v=\d+$/);
  const response = await call('GET', icon);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/svg+xml');
});

test('prompt files are read again whenever they change, even within the same instant', async (t) => {
  const { data, file, promptsDir } = await setup(t);
  assert.equal((await data()).prompts.length, 2);

  // Same size, written in place: only the modification time tells the change apart.
  const content = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, content.replace('First prompt', 'Fixed prompt'));
  assert.equal((await data()).prompts[0].prompt, 'Fixed prompt');

  fs.appendFileSync(file, `${record('aaaa1111-x', 3, 'Third prompt')}\n`);
  assert.equal((await data()).prompts.length, 3);

  fs.writeFileSync(path.join(promptsDir, '2026-11-20-bbbb2222.jsonl'), `${record('bbbb2222-y', 1, 'Other session')}\n`);
  assert.equal((await data()).sessions.length, 2);
  fs.rmSync(file);
  const after = await data();
  assert.deepEqual(after.prompts.map((p) => p.prompt), ['Other session']);
});
