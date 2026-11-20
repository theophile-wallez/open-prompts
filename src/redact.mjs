// Best-effort secret redaction, as required by SPEC.md section 6.
// Rules run in order, so the more specific ones come first.

const RULES = [
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai-key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}/g],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['stripe-key', /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['bearer-token', /(\bBearer\s+)([A-Za-z0-9._~+/-]{20,}=*)/g, 1],
  // Environment-style assignments: GITHUB_TOKEN=..., "DB_PASSWORD": "...", export API_KEY='...'
  [
    'secret',
    /(\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY)[A-Z0-9_]*["']?\s*[:=]\s*["']?)([^\s"'`,;)]{8,})/g,
    1,
  ],
];

/**
 * Replaces secrets in `text` with `[REDACTED:<kind>]`.
 * Returns the new text and the kinds of secrets that were found.
 */
export function redact(text) {
  const kinds = [];
  let result = text;
  for (const [kind, pattern, keepGroup] of RULES) {
    result = result.replace(pattern, (...match) => {
      const value = keepGroup ? match[keepGroup + 1] : match[0];
      if (value.startsWith('[REDACTED:')) return match[0];
      kinds.push(kind);
      return `${keepGroup ? match[keepGroup] : ''}[REDACTED:${kind}]`;
    });
  }
  return { text: result, kinds };
}
