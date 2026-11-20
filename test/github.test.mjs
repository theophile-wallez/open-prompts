import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubError, loadRepository, parseRepo, promptsDirOf } from '../src/ui/github.mjs';

const record = (session, n, prompt) =>
  JSON.stringify({ v: 1, id: `${session}-${n}`, timestamp: `2026-11-20T10:0${n}:00.000Z`, agent: 'claude-code', agent_version: '2.1.0', model: 'claude-opus-5-5', session, prompt });

const COMMIT = 'c0ffee0000000000000000000000000000000000';

/** A fake GitHub: one repository with a config, a prompts folder and two prompt files. */
function fakeGitHub({ isPrivate = false, dir = 'prompts', config = true, remaining = '50' } = {}) {
  const files = {
    '2026-11-20-aaaa.jsonl': `${record('aaaa', 1, 'First')}\n${record('aaaa', 2, 'Second')}\n`,
    '2026-11-21-bbbb.jsonl': `${record('bbbb', 1, 'Third')}\nnot json\n`,
  };
  const calls = [];
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'x-ratelimit-remaining': remaining } });
  const fetchImpl = async (url, init = {}) => {
    const auth = init.headers?.Authorization ?? null;
    calls.push({ url, auth, method: init.method ?? 'GET' });
    const u = new URL(url);
    if (remaining === '0') return json({ message: 'rate limit' }, 403);
    if (isPrivate && !auth && u.host === 'api.github.com') return json({ message: 'Not Found' }, 404);
    if (u.host === 'raw.githubusercontent.com') {
      if (isPrivate) return new Response('404', { status: 404 });
      const name = u.pathname.split('/').pop();
      if (u.pathname === `/Owner/Repo/${COMMIT}/.open-prompts.json`) return new Response(JSON.stringify({ version: 1, dir }));
      return files[name] ? new Response(files[name]) : new Response('404', { status: 404 });
    }
    const path = u.pathname;
    if (path === '/repos/owner/repo') return json({ full_name: 'Owner/Repo', name: 'Repo', private: isPrivate, default_branch: 'main', html_url: 'https://github.com/Owner/Repo', owner: { avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' } });
    if (path === '/repos/Owner/Repo/commits/main') return new Response(`${COMMIT}\n`);
    if (path === '/repos/Owner/Repo/commits/nope') return json({ message: 'No commit found' }, 422);
    if (path === `/repos/Owner/Repo/git/trees/${COMMIT}`) {
      const tree = [{ path: 'README.md', type: 'blob', sha: 'readme' }];
      if (config) tree.push({ path: '.open-prompts.json', type: 'blob', sha: 'config' });
      tree.push({ path: dir.split('/')[0], type: 'tree', sha: 'dir0' });
      return json({ tree });
    }
    if (path === '/repos/Owner/Repo/git/trees/dir0' && dir.includes('/')) return json({ tree: [{ path: dir.split('/')[1], type: 'tree', sha: 'dir1' }] });
    if (path === `/repos/Owner/Repo/git/trees/${dir.includes('/') ? 'dir1' : 'dir0'}`) {
      return json({ tree: [...Object.keys(files).reverse().map((name) => ({ path: name, type: 'blob', sha: `blob-${name}` })), { path: 'notes.txt', type: 'blob', sha: 'notes' }] });
    }
    if (path === '/repos/Owner/Repo/git/blobs/config') return new Response(JSON.stringify({ version: 1, dir }));
    if (path.startsWith('/repos/Owner/Repo/git/blobs/blob-')) return new Response(files[path.slice('/repos/Owner/Repo/git/blobs/blob-'.length)]);
    if (path === '/graphql') {
      const { variables } = JSON.parse(init.body);
      const object = {};
      Object.keys(variables).filter((k) => /^p\d+$/.test(k)).forEach((k) => {
        const mine = variables[k].endsWith('aaaa.jsonl');
        object[`f${k.slice(1)}`] = {
          nodes: [
            { author: { name: 'Later', email: 'later@example.com', user: null } },
            { author: mine ? { name: 'Ada L', email: 'ada@example.com', user: { login: 'ada', name: 'Ada Lovelace', avatarUrl: 'https://avatars.githubusercontent.com/u/2' } } : { name: 'Bob', email: 'Bob@Example.com', user: null } },
          ],
        };
      });
      return json({ data: { viewer: { login: 'ADA' }, repository: { object } } });
    }
    return json({ message: 'Not Found' }, 404);
  };
  return { fetchImpl, calls };
}

test('parseRepo reads names, links and remotes', () => {
  const plain = { owner: 'owner', repo: 'repo', ref: null };
  assert.deepEqual(parseRepo('owner/repo'), plain);
  assert.deepEqual(parseRepo(' https://github.com/owner/repo/ '), plain);
  assert.deepEqual(parseRepo('github.com/owner/repo.git'), plain);
  assert.deepEqual(parseRepo('git@github.com:owner/repo.git'), plain);
  assert.deepEqual(parseRepo('https://github.com/owner/repo/pulls?q=1#x'), plain);
  assert.deepEqual(parseRepo('https://github.com/owner/repo/tree/feature/x'), { owner: 'owner', repo: 'repo', ref: 'feature/x' });
  for (const bad of ['', 'owner', 'https://gitlab.com/owner/repo', 'own er/repo', 'owner/..', '-owner/repo', null]) assert.equal(parseRepo(bad), null, String(bad));
});

test('promptsDirOf falls back to the default folder for a missing or unsafe one', () => {
  assert.equal(promptsDirOf('{"version":1,"dir":"docs/prompts/"}'), 'docs/prompts');
  assert.equal(promptsDirOf('{"version":1}'), 'prompts');
  assert.equal(promptsDirOf('not json'), 'prompts');
  assert.equal(promptsDirOf('{"dir":"../secrets"}'), 'prompts');
  assert.equal(promptsDirOf('{"dir":"/etc"}'), 'prompts');
});

test('reads a public repository without a token, the files from raw.githubusercontent.com', async () => {
  const { fetchImpl, calls } = fakeGitHub();
  const data = await loadRepository(parseRepo('owner/repo'), { fetchImpl });
  assert.equal(data.project.fullName, 'Owner/Repo');
  assert.equal(data.project.ref, 'main');
  assert.equal(data.project.commit, COMMIT);
  assert.equal(data.project.icon, 'https://avatars.githubusercontent.com/u/1?v=4&s=64');
  assert.deepEqual(data.sessions.map((s) => [s.file, s.count, s.git]), [['2026-11-20-aaaa.jsonl', 2, null], ['2026-11-21-bbbb.jsonl', 1, null]]);
  assert.deepEqual(data.prompts.map((p) => p.prompt), ['First', 'Second', 'Third']);
  assert.deepEqual(data.contributors, {}, 'authors need GraphQL, so a token');
  const api = calls.filter((c) => c.url.startsWith('https://api.github.com'));
  assert.equal(api.length, 4, 'repository, commit, root tree, prompts tree');
  assert.ok(calls.every((c) => c.auth === null));
});

test('reads a private repository with a token, and finds who added each session', async () => {
  const { fetchImpl, calls } = fakeGitHub({ isPrivate: true, dir: 'docs/prompts' });
  await assert.rejects(loadRepository(parseRepo('owner/repo'), { fetchImpl }), (error) => error instanceof GitHubError && error.kind === 'not-found' && /add a token/.test(error.message));
  const data = await loadRepository(parseRepo('owner/repo'), { fetchImpl, token: 'github_pat_x' });
  assert.equal(data.project.private, true);
  assert.equal(data.project.dir, 'docs/prompts');
  assert.equal(data.prompts.length, 3);
  assert.ok(!calls.some((c) => c.auth && !c.url.startsWith('https://api.github.com/')), 'the token only goes to the API');
  const [ada, bob] = data.sessions.map((s) => s.author);
  assert.equal(ada, 'github.com:ada');
  assert.equal(bob, 'email:bob@example.com');
  assert.deepEqual(data.contributors[ada], { name: 'Ada Lovelace', login: 'ada', host: 'github.com', url: 'https://github.com/ada', avatar: 'https://avatars.githubusercontent.com/u/2', you: true, aliases: [] });
  assert.equal(data.contributors[bob].name, 'Bob');
});

test('explains a missing branch, a repository without prompts, and the rate limit', async () => {
  await assert.rejects(loadRepository({ owner: 'owner', repo: 'repo', ref: 'nope' }, { fetchImpl: fakeGitHub().fetchImpl }), /no branch, tag or commit named "nope"/);
  await assert.rejects(loadRepository(parseRepo('owner/repo'), { fetchImpl: fakeGitHub({ config: false, dir: 'src' }).fetchImpl }), (error) => error.kind === 'no-prompts');
  await assert.rejects(loadRepository(parseRepo('owner/repo'), { fetchImpl: fakeGitHub({ remaining: '0' }).fetchImpl }), (error) => error.kind === 'rate-limited');
});
