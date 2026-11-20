import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { findProject } from '../src/project.mjs';
import { accountFromEmail, committedAuthors, createContributors, parseRemote } from '../src/ui/contributors.mjs';
import { readProjectData, startServer } from '../src/ui/server.mjs';
import { tempDir } from './helpers.mjs';

const run = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

const line = (session, prompt) => `${JSON.stringify({ v: 1, id: `${session}-1`, timestamp: '2026-11-20T10:00:00.000Z', agent: 'codex', session, prompt })}\n`;

/** A repository with one session committed by each of two people, and one session not committed yet. */
function teamRepo() {
  const root = tempDir();
  run(root, 'init', '-q');
  run(root, 'config', 'user.name', 'Local Me');
  run(root, 'config', 'user.email', 'me@example.com');
  run(root, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');
  fs.writeFileSync(path.join(root, '.open-prompts.json'), JSON.stringify({ version: 1, dir: 'prompts' }));
  fs.mkdirSync(path.join(root, 'prompts'));
  const add = (name, author) => {
    fs.writeFileSync(path.join(root, 'prompts', name), line(name.slice(11, 19), `Prompt of ${name}`));
    run(root, 'add', '.');
    run(root, 'commit', '-qm', name, `--author=${author}`);
  };
  add('2026-11-20-aaaa1111.jsonl', 'Ada <1234+ada-l@users.noreply.github.com>');
  add('2026-11-20-bbbb2222.jsonl', 'Bob <bob@example.com>');
  fs.writeFileSync(path.join(root, 'prompts', '2026-11-20-cccc3333.jsonl'), line('cccc3333', 'Not committed yet'));
  return { root, project: findProject(root) };
}

test('remote addresses and noreply emails name the forge account', () => {
  assert.deepEqual(parseRemote('git@github.com:acme/app.git'), { host: 'github.com', path: 'acme/app' });
  assert.deepEqual(parseRemote('https://gitlab.com/group/sub/app.git'), { host: 'gitlab.com', path: 'group/sub/app' });
  assert.deepEqual(parseRemote('ssh://git@git.example.com:2222/acme/app'), { host: 'git.example.com', path: 'acme/app' });
  assert.equal(parseRemote('/local/path'), null);
  assert.deepEqual(accountFromEmail('1234+Ada-L@users.noreply.github.com'), { host: 'github.com', login: 'ada-l', id: 1234 });
  assert.deepEqual(accountFromEmail('ada@users.noreply.github.com'), { host: 'github.com', login: 'ada', id: null });
  assert.deepEqual(accountFromEmail('77-bob@users.noreply.gitlab.com'), { host: 'gitlab.com', login: 'bob', id: 77 });
  assert.equal(accountFromEmail('bob@example.com'), null);
});

test('each session is credited to the commit that added its file, or to the local user', () => {
  const { root, project } = teamRepo();
  const authors = committedAuthors(root, project.promptsDir);
  assert.equal(authors.get('2026-11-20-aaaa1111.jsonl').name, 'Ada');
  assert.equal(authors.get('2026-11-20-bbbb2222.jsonl').email, 'bob@example.com');
  assert.equal(authors.has('2026-11-20-cccc3333.jsonl'), false);

  const contributors = createContributors({ project, cacheDir: tempDir(), offline: true });
  const data = readProjectData(project, {}, contributors);
  const byFile = Object.fromEntries(data.sessions.map((s) => [s.file, s.author]));
  assert.equal(byFile['2026-11-20-aaaa1111.jsonl'], 'github.com:ada-l');
  assert.equal(byFile['2026-11-20-bbbb2222.jsonl'], 'email:bob@example.com');
  assert.equal(byFile['2026-11-20-cccc3333.jsonl'], 'email:me@example.com');
  assert.equal(data.contributors['github.com:ada-l'].url, 'https://github.com/ada-l');
  assert.equal(data.contributors['github.com:ada-l'].avatar, null, 'no avatar is offered offline');
  assert.equal(data.contributors['email:me@example.com'].you, true);
  assert.equal(data.contributors['email:bob@example.com'].name, 'Bob');
});

test('accounts are looked up on GitHub in the background, then avatars are served locally', async (t) => {
  const { project } = teamRepo();
  const requests = [];
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const fetchImpl = async (url) => {
    requests.push(url);
    const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (/\/repos\/acme\/app\/commits\//.test(url)) return json({ author: { login: 'bobby', id: 42, avatar_url: 'https://avatars.example/u/42' } });
    if (url.endsWith('/users/bobby')) return json({ login: 'bobby', id: 42, name: 'Bob Builder', avatar_url: 'https://avatars.example/u/42' });
    if (url.endsWith('/users/ada-l')) return json({ login: 'ada-l', id: 1234, name: 'Ada Lovelace', avatar_url: 'https://avatars.example/u/1234' });
    if (url.startsWith('https://avatars.example/')) return new Response(png, { headers: { 'content-type': 'image/png' } });
    return new Response('{}', { status: 404 });
  };
  const env = { OPEN_PROMPTS_STATE_DIR: tempDir() };
  const ui = await startServer(project, { env, fetchImpl, useGh: false });
  t.after(() => ui.close());
  const cookie = (await fetch(ui.url, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
  const get = (url) => fetch(`http://127.0.0.1:${ui.port}${url}`, { headers: { cookie } });

  const first = await (await get('/api/data')).json();
  assert.equal(first.contributors['email:bob@example.com'].name, 'Bob');
  let data;
  for (let i = 0; i < 50; i++) {
    data = await (await get('/api/data')).json();
    if (data.contributors['github.com:bobby']) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const bob = data.contributors['github.com:bobby'];
  assert.equal(bob.name, 'Bob Builder');
  assert.deepEqual(bob.aliases, ['email:bob@example.com']);
  assert.equal(data.contributors['github.com:ada-l'].name, 'Ada Lovelace');
  // The local user has no commit and no noreply address: nothing to look up on GitHub.
  assert.equal(data.contributors['email:me@example.com'].login, null);

  const image = await get(bob.avatar);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  await get(bob.avatar);
  assert.equal(requests.filter((url) => url === 'https://avatars.example/u/42').length, 1, 'the avatar is downloaded once');
  assert.equal((await get('/avatar/0123456789abcdef0123')).status, 404);
  assert.ok(requests.every((url) => !url.includes('example.com')), 'emails are not sent to GitHub');
});
