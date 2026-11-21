import assert from 'node:assert/strict';
import test from 'node:test';
import { auditPrompt } from '../src/audit.mjs';

const reasons = (text, options) => auditPrompt(text, options).map(({ reason }) => reason);

test('audit flags passwords with "@" alone or after an email, and masks them', () => {
  assert.deepEqual(auditPrompt('P@ssw0rd!'), [{ reason: 'password', excerpt: 'P@s…' }]);
  assert.deepEqual(auditPrompt('connecte toi: jane.doe@example.com P@ssw0rd!'), [{ reason: 'email and password', excerpt: 'connecte toi: jan…' }]);
  assert.deepEqual(reasons('login jane.doe@example.com, Tr0ub4dor&3'), ['email and password']);
});

test('excerpts also hide the password-like words around a finding', () => {
  const [finding] = auditPrompt('ping jane.doe@example.com tomorrow, my key is Zx8kQ2!mP9v');
  assert.equal(finding.reason, 'email');
  assert.doesNotMatch(finding.excerpt, /Zx8kQ2!mP9v/);
  assert.match(finding.excerpt, /ping jan… tomorrow, my key is Zx8…/);
});

test('audit reads keywords with no-break spaces and guillemets', () => {
  assert.deepEqual(reasons('mot de passe\u00a0: Tr0ub4dor&3'), ['password']);
  assert.deepEqual(reasons('le token est « Zx8kQ2mP9vL4 »'), ['password or secret keyword']);
});

test('retina asset names are not emails, and home directories with spaces or under WSL are found', () => {
  assert.deepEqual(reasons('replace icon@2x.png and logo@3x.webp'), []);
  assert.deepEqual(auditPrompt('open C:\\Users\\Jane Doe\\proj'), [{ reason: 'home directory', excerpt: 'open C:\\Users\\Jan…\\proj' }]);
  assert.deepEqual(auditPrompt('open /mnt/c/Users/jane/proj'), [{ reason: 'home directory', excerpt: 'open /mnt/c/Users/…/proj' }]);
  assert.deepEqual(reasons('open /mnt/c/Users/jane/proj', { homePaths: false }), []);
});
