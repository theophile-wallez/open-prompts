import assert from 'node:assert/strict';
import test from 'node:test';
import { redact } from '../src/redact.mjs';

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
    assert.deepEqual(redact(input), { text: input, kinds: [] });
  }
});
