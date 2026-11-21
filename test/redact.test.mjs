import assert from 'node:assert/strict';
import test from 'node:test';
import { findSecrets, redact } from '../src/redact.mjs';

const cases = [
  ['anthropic-key', 'use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 please'],
  ['openai-key', 'key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'],
  ['github-token', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB'],
  ['aws-access-key', 'AKIAABCDEFGHIJKLMNOP is the id'],
  ['slack-token', 'xoxb-1234567890-abcdefghij'],
  ['npm-token', 'npm_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
];

for (const [kind, input] of cases) {
  test(`redacts ${kind}`, () => {
    const { text, kinds } = redact(input);
    assert.ok(text.includes(`[REDACTED:${kind}]`), text);
    assert.deepEqual(kinds, [kind]);
  });
}

test('keeps the prefix of bearer tokens and secret assignments', () => {
  assert.equal(redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz').text, 'Authorization: Bearer [REDACTED:bearer-token]');
  assert.equal(redact('export DB_PASSWORD=hunter2hunter2').text, 'export DB_PASSWORD=[REDACTED:secret]');
  assert.equal(redact('"STRIPE_API_KEY": "abcd1234efgh"').text, '"STRIPE_API_KEY": "[REDACTED:secret]"');
});

test('redacts private key blocks', () => {
  const input = 'here:\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----\nthanks';
  assert.equal(redact(input).text, 'here:\n[REDACTED:private-key]\nthanks');
});

test('leaves ordinary prompts and code alone', () => {
  for (const input of [
    'Refactor the token parser in src/lexer.ts',
    'const token = getToken(); if (token) refresh()',
    'Why does the password reset email not arrive?',
    'Rename skeleton to sk-layout',
  ]) {
    assert.deepEqual(redact(input), { text: input, kinds: [], homePaths: 0 });
  }
});

test('redacts npm login links', () => {
  const input = 'Authenticate your account at:\nhttps://www.npmjs.com/auth/cli/8f1958a8-0a1b-43b9-b816-6bcb6b5bf559\nthen https://registry.npmjs.org/-/v1/done?authId=8f1958a8-0a1b-43b9-b816-6bcb6b5bf559';
  assert.equal(
    redact(input).text,
    'Authenticate your account at:\nhttps://www.npmjs.com/auth/cli/[REDACTED:npm-auth-link]\nthen https://registry.npmjs.org/-/v1/done?authId=[REDACTED:npm-auth-link]',
  );
});

// ---------------------------------------------------------------------------
// Cookies

test('redacts cookie headers, --cookie arguments and curl -b', () => {
  for (const [input, expected] of [
    ['pnpm app:login --cookie="lila2=1; sessionId=Zx8kQ2mP9vL4tR7w&sid=a8f9c0d1e2b3a4f5"', 'pnpm app:login --cookie="[REDACTED:cookie]"'],
    ["node login.js --cookie 'sid=a8f9c0d1e2b3a4f5c6d7'", "node login.js --cookie '[REDACTED:cookie]'"],
    ['run it with --cookie=s%3Aa8f9c0d1e2b3a4f5c6d7e8f9', 'run it with --cookie=[REDACTED:cookie]'],
    ["curl -s -b 'connect.sid=s%3AZx8kQ2mP9vL4' https://example.com", "curl -s -b '[REDACTED:cookie]' https://example.com"],
    ["curl -H 'Cookie: theme=dark; session=a8f9c0d1e2b3a4f5c6d7' https://example.com", "curl -H 'Cookie: [REDACTED:cookie]' https://example.com"],
    ['Set-Cookie: PHPSESSID=9f8e7d6c5b4a39281706; Path=/; HttpOnly', 'Set-Cookie: [REDACTED:cookie]'],
  ]) {
    const { text, kinds } = redact(input);
    assert.equal(text, expected);
    assert.deepEqual(kinds, ['cookie']);
  }
});

test('redacts session parameters with secret-looking values', () => {
  assert.equal(redact('open https://example.com/play?sessionId=Zx8kQ2mP9vL4tR7wN3bY').text, 'open https://example.com/play?sessionId=[REDACTED:cookie]');
  assert.equal(redact('PHPSESSID=9f8e7d6c5b4a39281706').text, 'PHPSESSID=[REDACTED:cookie]');
  assert.equal(redact('connect.sid=s%3Aa8f9c0d1e2b3a4f5c6d7').text, 'connect.sid=[REDACTED:cookie]');
});

test('leaves ordinary mentions of cookies and sessions alone', () => {
  for (const input of [
    'fix sid=1 bug',
    'the Cookie: header is missing on the second request',
    'set session=true in the config',
    'sessionId=getSessionId() is called twice',
    'git checkout -b feature/cookie-banner',
    'curl -b cookies.txt https://example.com',
    'why does --cookie fail when it is empty?',
    'const session = await getSession(request)',
  ]) {
    assert.deepEqual(redact(input).kinds, [], input);
    assert.equal(redact(input).text, input);
  }
});

// ---------------------------------------------------------------------------
// Passwords

test('redacts an email followed by a password, and both', () => {
  for (const [input, expected] of [
    ['connecte toi: jane.doe@example.com Tr0ub4dor&3', 'connecte toi: [REDACTED:email] [REDACTED:password]'],
    ['log in as jane.doe@example.com / hunter22', 'log in as [REDACTED:email] / [REDACTED:password]'],
    ['jane.doe@example.com:Tr0ub4dor&3', '[REDACTED:email]:[REDACTED:password]'],
    ['use jane.doe@example.com  S3cret!pass then open the dashboard', 'use [REDACTED:email]  [REDACTED:password] then open the dashboard'],
  ]) {
    const { text, kinds } = redact(input);
    assert.equal(text, expected);
    assert.deepEqual(kinds.sort(), ['email', 'password']);
  }
});

test('keeps an email followed by an ordinary word, a version, a path or a date', () => {
  for (const input of [
    'send it to foo@bar.com please',
    'send it to foo@bar.com. Thanks!',
    'ask foo@bar.com (admin) for access',
    'the author is jane.doe@example.com v2.0.1',
    'committed by jane.doe@example.com 2026-11-20',
    'git@github.com:org/repo.git is the remote',
    'mail foo@bar.com about issue#1234',
    'jane.doe@example.com, bob@example.com and others',
    'contact foo@bar.com --verbose',
  ]) {
    assert.deepEqual(redact(input), { text: input, kinds: [], homePaths: 0 }, input);
  }
});

test('a prompt that is only a password or only an email is redacted', () => {
  assert.deepEqual(redact('Tr0ub4dor&3'), { text: '[REDACTED:password]', kinds: ['password'], homePaths: 0 });
  assert.deepEqual(redact('  Summer2024!\n'), { text: '[REDACTED:password]', kinds: ['password'], homePaths: 0 });
  assert.deepEqual(redact('jane.doe@example.com'), { text: '[REDACTED:email]', kinds: ['email'], homePaths: 0 });
});

test('a prompt that is one ordinary token stays', () => {
  for (const input of [
    'continue', 'yes', 'Thanks!', '/compact', '/review 42', 'README.md', 'src/redact.mjs', 'useState2', 'v1.2.3-beta.1',
    'Python3', '2026-11-20', 'e2e-tests', 'ENV_VAR_2', 'https://example.com/a?b=1', '@claude', '$HOME', 'getUser()',
    '9f8e7d6c5b4a3928', '8f1958a8-0a1b-43b9-b816-6bcb6b5bf559', '#1234', '--force', '100%', '42/42', '********',
  ]) {
    assert.deepEqual(redact(input).kinds, [], input);
  }
});

test('redacts passwords after a keyword, in several languages', () => {
  for (const [input, expected] of [
    ['the password is hunter22', 'the password is [REDACTED:password]'],
    ['password: hunter2', 'password: [REDACTED:password]'],
    ['my pwd = Tr0ub4dor&3', 'my pwd = [REDACTED:password]'],
    ['"password": "Secret123"', '"password": "[REDACTED:password]"'],
    ['db_password=s3cr3t!', 'db_password=[REDACTED:password]'],
    ['le mot de passe est Chocolat42!', 'le mot de passe est [REDACTED:password]'],
    ["mon mdp c'est azerty123", "mon mdp c'est [REDACTED:password]"],
    ['mot de passe : 4zerty!', 'mot de passe : [REDACTED:password]'],
    ['la contraseña es Perro2024', 'la contraseña es [REDACTED:password]'],
    ['la clave: gato_99', 'la clave: [REDACTED:password]'],
    ['a senha é Batata#7', 'a senha é [REDACTED:password]'],
    ['das Passwort ist Sommer2024', 'das Passwort ist [REDACTED:password]'],
    ['Kennwort: Geheim#1', 'Kennwort: [REDACTED:password]'],
    ['la parola è Ciao1234', 'la parola è [REDACTED:password]'],
    ['het wachtwoord is Fiets123', 'het wachtwoord is [REDACTED:password]'],
    ['пароль: Qwerty123', 'пароль: [REDACTED:password]'],
    ['我的密码是hunter22', '我的密码是[REDACTED:password]'],
    ['パスワード：Sakura2024', 'パスワード：[REDACTED:password]'],
    ['PIN password: 48213907', 'PIN password: [REDACTED:password]'],
    ['user jdoe password Tr0ub4dor&3', 'user jdoe password [REDACTED:password]'],
    ['- **Password**: hunter22', '- **Password**: [REDACTED:password]'],
  ]) {
    const { text, kinds } = redact(input);
    assert.equal(text, expected, input);
    assert.deepEqual(kinds, ['password'], input);
  }
});

test('keeps sentences and code about passwords', () => {
  for (const input of [
    'password is required',
    'the password reset email does not arrive',
    'Why does the password reset email not arrive?',
    'the password is too short',
    'the password is 3 characters too short',
    'password: string',
    'password: z.string().min(8)',
    'password = req.body.password',
    "password: process.env.DB_PASS",
    'password: ${PASSWORD}',
    'password: <your-password>',
    "password: '********'",
    'make the tests pass: run them twice',
    'tests pass: 42/42',
    'pass = 0',
    'pwd: /tmp/project',
    'run pwd = os.getcwd()',
    'le mot de passe est obligatoire',
    'la clave es entender el problema',
    'the compass is broken',
    'bypass: true',
  ]) {
    assert.deepEqual(redact(input).kinds, [], input);
  }
});

test('redacts the password of a URL', () => {
  assert.equal(redact('connect to postgres://app:Tr0ub4dor@db.internal:5432/app').text, 'connect to postgres://app:[REDACTED:password]@db.internal:5432/app');
  assert.deepEqual(redact('see https://example.com:8080/docs').kinds, []);
});

// ---------------------------------------------------------------------------
// Options

test('emails anywhere are redacted only with the emails option', () => {
  const input = 'send it to jane.doe@example.com please, not to git@github.com';
  assert.equal(redact(input).text, input);
  const { text, kinds } = redact(input, { emails: true });
  assert.equal(text, 'send it to [REDACTED:email] please, not to git@github.com');
  assert.deepEqual(kinds, ['email']);
});

test('home directories become ~ unless homePaths is off', () => {
  const input = 'read /Users/jane/code/app/README.md, /home/jane-doe and C:\\Users\\Jane\\Desktop\\notes.txt';
  const result = redact(input);
  assert.equal(result.text, 'read ~/code/app/README.md, ~ and ~\\Desktop\\notes.txt');
  assert.deepEqual(result.kinds, [], 'home paths are not secrets');
  assert.equal(result.homePaths, 3);
  assert.deepEqual(redact(input, { homePaths: false }), { text: input, kinds: [], homePaths: 0 });
});

test('leaves shared and nested Users directories alone', () => {
  for (const input of [
    'copy it to /Users/Shared/build',
    'edit src/Users/List.tsx',
    'open https://example.com/home/jane/profile',
    'C:\\Users\\Public\\Documents',
    '/home/linuxbrew/.linuxbrew/bin/node',
  ]) {
    assert.equal(redact(input).text, input, input);
  }
});

test('redaction is idempotent', () => {
  for (const input of [
    'connecte toi: jane.doe@example.com Tr0ub4dor&3', 'password: "hunter2"', 'Tr0ub4dor&3', '我的密码是hunter22', 'user: jane@example.com pass: Tr0ub4dor&3',
    'jane.doe@example.com\nTr0ub4dor&3', 'le mot de passe est « Tr0ub4dor&3 »', '`jane.doe@example.com` `Tr0ub@dor3`', '{"Cookie": "lila2=Xy7Kq9Lm3Np5Rs8T"}',
  ]) {
    const once = redact(input).text;
    assert.deepEqual(redact(once), { text: once, kinds: [], homePaths: 0 }, input);
  }
});

test('findSecrets reports what redact would replace, with positions', () => {
  const text = 'login: jane.doe@example.com Tr0ub4dor&3 then token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';
  const found = findSecrets(text);
  assert.deepEqual(found.map((f) => f.kind), ['email-and-password', 'github-token']);
  assert.equal(text.slice(found[1].index, found[1].index + found[1].length), 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB');
  assert.deepEqual(findSecrets('password is required'), []);
  assert.deepEqual(findSecrets('Tr0ub4dor&3').map((f) => f.kind), ['password']);
});

// ---------------------------------------------------------------------------
// Passwords with "@", "$" or hex letters, and false positives on code

test('passwords with "@", "$", hex letters or a dot are redacted after a keyword, an email, or alone', () => {
  for (const [input, expected] of [
    ['Password: P@ssw0rd!', 'Password: [REDACTED:password]'],
    ['mot de passe: Azerty@2024', 'mot de passe: [REDACTED:password]'],
    ['mdp : Admin@2024', 'mdp : [REDACTED:password]'],
    ['password: abc12345', 'password: [REDACTED:password]'],
    ['senha: Abc12345', 'senha: [REDACTED:password]'],
    ['password: Facade2024', 'password: [REDACTED:password]'],
    ['password: $ecret123', 'password: [REDACTED:password]'],
    ['password: Summer2024.Fall', 'password: [REDACTED:password]'],
    ['密码: Abc12345', '密码: [REDACTED:password]'],
    ['请用密码是Abc12345登录', '请用密码是[REDACTED:password]登录'],
    ['connecte toi: jane.doe@example.com Tr0ub@dor3', 'connecte toi: [REDACTED:email] [REDACTED:password]'],
    ['login jane.doe@example.com P@ssw0rd!', 'login [REDACTED:email] [REDACTED:password]'],
    ['login jane.doe@example.com Deadbeef1', 'login [REDACTED:email] [REDACTED:password]'],
    ['Tr0ub@dor3', '[REDACTED:password]'],
    ['S3cure@Pass!', '[REDACTED:password]'],
    ['Admin@2024', '[REDACTED:password]'],
    ['Abc12345', '[REDACTED:password]'],
  ]) {
    assert.equal(redact(input).text, expected, input);
  }
});

test('mentions, packages, hashes and identifiers alone are not passwords', () => {
  for (const input of [
    '@Jane2', 'react@18', 'lodash@4.17.21', '@scope/pkg', 'deadbeef12', 'OAuth2Client', 'Button2Group', 'Base64Encoder', 'IPv6Address', 'S3Bucket',
    'Http2Server', 'OAuth2.0', 'Python3.12', 'sha256:abc', 'test:e2e', 'e2e:CI', 'feat:Login', 'WIP:Tests2', 'fix:#123', 'Fix#123', 'fix-bug-#42',
    'a&&b||c1', 'node>=18', 'Hello!1', 'Merci!2', 'C:/Users/jane/proj',
  ]) {
    assert.deepEqual(redact(input, { homePaths: false }).kinds, [], input);
  }
});

test('"pass" and "clave" as ordinary words, and code after a keyword, are kept', () => {
  for (const input of [
    'pass MyComponent2 as a prop',
    'pass OAuth2Client here',
    'pass HTTP2Server to the factory',
    'we pass Base64URL strings',
    'first pass: Step1Done',
    'pass: x86_64-linux',
    'pass: H264Decoder',
    'clave: UserId2',
    'password=os.environ["PW2"]',
    'password: env("DB_PASS")',
    'password: !Ref DbPassword2',
    'e.g. password: <your password>',
    'mdp: <ton mdp>',
  ]) {
    assert.deepEqual(redact(input), { text: input, kinds: [], homePaths: 0 }, input);
  }
  assert.equal(redact('pass: Tr0ub4dor&3').text, 'pass: [REDACTED:password]');
  assert.equal(redact('la clave: gato_99').text, 'la clave: [REDACTED:password]');
});

test('no-break spaces, guillemets and other spellings of the keyword', () => {
  for (const [input, expected] of [
    ['mot de passe\u00a0: Tr0ub4dor&3', 'mot de passe\u00a0: [REDACTED:password]'],
    ['mdp\u202f: azerty123', 'mdp\u202f: [REDACTED:password]'],
    ['le\u00a0mot de\u00a0passe est Tr0ub4dor&3', 'le\u00a0mot de\u00a0passe est [REDACTED:password]'],
    ['le mot de passe est « Tr0ub4dor&3 »', 'le mot de passe est « [REDACTED:password] »'],
    ['the password is “Tr0ub4dor&3”', 'the password is “[REDACTED:password]”'],
    ['Mot-de-passe: Tr0ub4dor&3', 'Mot-de-passe: [REDACTED:password]'],
    ['das Passwort lautet: Sommer2024', 'das Passwort lautet: [REDACTED:password]'],
    ['passcode: 482913', 'passcode: [REDACTED:password]'],
    ['jane.doe@example.com\u00a0Tr0ub4dor&3', '[REDACTED:email]\u00a0[REDACTED:password]'],
  ]) {
    assert.equal(redact(input).text, expected, input);
  }
});

test('an email and a password: more separators, quotes, two lines, and keyword credentials', () => {
  for (const [input, expected] of [
    ['login jane.doe@example.com, Tr0ub4dor&3', 'login [REDACTED:email], [REDACTED:password]'],
    ['jane.doe@example.com; Tr0ub4dor&3', '[REDACTED:email]; [REDACTED:password]'],
    ['jane.doe@example.com — Tr0ub4dor&3', '[REDACTED:email] — [REDACTED:password]'],
    ['`jane.doe@example.com` `Tr0ub4dor&3`', '`[REDACTED:email]` `[REDACTED:password]`'],
    ['jane.doe@example.com\nTr0ub4dor&3', '[REDACTED:email]\n[REDACTED:password]'],
    ['login:\njane.doe@example.com\nTr0ub4dor&3\nthen open the app', 'login:\n[REDACTED:email]\n[REDACTED:password]\nthen open the app'],
    ['user: jane@example.com pass: Tr0ub4dor&3', 'user: [REDACTED:email] pass: [REDACTED:password]'],
  ]) {
    const { text, kinds } = redact(input);
    assert.equal(text, expected, input);
    assert.deepEqual([...new Set(kinds)].sort(), ['email', 'password'], input);
  }
});

test('an email followed by a ticket, a date, a time or a plain word is kept', () => {
  for (const input of [
    'assign to jane.doe@example.com PROJ-1234 today',
    'see user@example.com TODO-1234',
    'ping jane.doe@example.com tomorrow2',
    'mail jane.doe@example.com: Q3-2024 report',
    'invite jane.doe@example.com/admin2 role',
    'call jane@example.com 10:30am tomorrow',
    'author jane@example.com 2fa-enabled',
    'last login jane.doe@example.com 2026-11-20T10:00:00Z',
    'send to jane@example.com\nthanks!',
    'mail jane@example.com\nMyComponent2 is broken',
  ]) {
    assert.deepEqual(redact(input), { text: input, kinds: [], homePaths: 0 }, input);
  }
});

test('cookies in a headers object, document.cookie and prose are redacted', () => {
  for (const [input, expected] of [
    ['{"Cookie": "lila2=Xy7Kq9Lm3Np5Rs8T"}', '{"Cookie": "[REDACTED:cookie]"}'],
    ['fetch(url, { headers: { cookie: "lila2=Xy7Kq9Lm3Np5Rs8T" } })', 'fetch(url, { headers: { cookie: "[REDACTED:cookie]" } })'],
    ['document.cookie = "lila2=Xy7Kq9Lm3Np5Rs8T"', 'document.cookie = "[REDACTED:cookie]"'],
    ['my cookie is lila2=Xy7Kq9Lm3Np5Rs8T and it fails', 'my cookie is [REDACTED:cookie] and it fails'],
    ['auth_token=Xy7Kq9Lm3Np5Rs8T', 'auth_token=[REDACTED:cookie]'],
  ]) {
    assert.equal(redact(input).text, expected, input);
  }
});

test('session parameters with ordinary values are kept', () => {
  for (const input of [
    'run with SESSION=production-cluster-1 please',
    'http://localhost:3000/review?session=2024-11-20-standup',
    'the sid=user-profile-page-v2 param',
    'sessionKey=config.session.key2',
    'session=src/pages/session2.tsx',
  ]) {
    assert.deepEqual(redact(input).kinds, [], input);
  }
});

test('Windows user names with spaces, WSL paths and C:/Users are hidden', () => {
  assert.equal(redact('C:\\Users\\Jane Doe\\proj\\a.ts').text, '~\\proj\\a.ts');
  assert.equal(redact('open "C:\\Users\\Jane Doe" now').text, 'open "~" now');
  assert.equal(redact('in C:\\Users\\Jane is my folder').text, 'in ~ is my folder');
  assert.equal(redact('/mnt/c/Users/jane/proj').text, '~/proj');
  assert.equal(redact('C:/Users/jane/proj').text, '~/proj');
  assert.equal(redact('C:\\Users\\Default User\\AppData').text, 'C:\\Users\\Default User\\AppData');
});

test('retina asset names are not emails', () => {
  const input = 'replace icon@2x.png and logo@3x.webp, mail jane@example.com';
  assert.equal(redact(input, { emails: true }).text, 'replace icon@2x.png and logo@3x.webp, mail [REDACTED:email]');
});

test('findSecrets reports a lone password with "@" as a password', () => {
  assert.deepEqual(findSecrets('P@ssw0rd!').map((f) => f.kind), ['password']);
  assert.deepEqual(findSecrets('jane.doe@example.com').map((f) => f.kind), ['email']);
  const text = 'user: jane@example.com pass: Tr0ub4dor&3';
  assert.deepEqual(findSecrets(text).map((f) => [f.kind, text.slice(f.index, f.index + f.length)]), [['email', 'jane@example.com'], ['password', 'Tr0ub4dor&3']]);
});
