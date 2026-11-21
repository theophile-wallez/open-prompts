// Best-effort secret redaction, as required by SPEC.md section 6.
// Rules run in order, so the more specific ones come first.
//
// A rule's pattern marks the secret with a `secret` group. Text in the optional `pre` and
// `post` groups is kept around the `[REDACTED:<kind>]` marker. Without a `secret` group,
// the whole match is the secret. `accept` can turn down a match that does not look secret.

/**
 * An email address. The local part must not follow another address character. Retina
 * asset names such as `icon@2x.png` and names ending in an image extension are not emails.
 */
export const EMAIL = String.raw`(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@(?!\d+x\.)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.(?!(?:png|jpe?g|gif|webp|svg|avif|ico|bmp|tiff?)(?![A-Za-z0-9-]))[A-Za-z]{2,}(?![A-Za-z0-9-])`;
const WHOLE_EMAIL = new RegExp(`^${EMAIL}$`);

/** Blanks: a tab, a space, or a no-break space, which French puts before ":". */
const S = String.raw`[\t\p{Zs}]`;

/**
 * Words for "password" in several languages. PASSWORD_WORDS are matched as whole words.
 * PASSWORD_WORDS_CJK, from scripts written without spaces, can sit right next to other text.
 */
export const PASSWORD_WORDS = [
  'password', 'passwd', 'passphrase', 'passcode', 'pass', 'pwd', 'pw',
  'mot de passe', 'mdp',
  'contraseña', 'contrasena', 'clave',
  'senha',
  'passwort', 'kennwort',
  'parola', 'parolă',
  'wachtwoord',
  'hasło', 'haslo',
  'lösenord', 'losenord', 'passord', 'adgangskode', 'salasana',
  'şifre', 'sifre', 'heslo', 'jelszó', 'geslo', 'lozinka',
  'пароль', 'κωδικός',
];
export const PASSWORD_WORDS_CJK = ['密码', '密碼', 'パスワード', '비밀번호', '암호'];
/**
 * Words that also mean something else ("pass" a value, a code review "pass", "clave" as
 * "key", "parola" as "word"): what follows them needs ":", "=" or "is", and must not be code.
 */
const AMBIGUOUS_WORDS = new Set(['pass', 'pw', 'clave', 'parola']);
const VERB_WORDS = new Set(['pass', 'pw']);

/** "is" and its translations, as in "the password is …". */
export const COPULAS = ["is", "was", "est", "c['’]est", "es", "era", "ist", "war", "lautet", "é", "è", "e", "är", "er", "jest", "je", "это", "—", "-"];
const CJK_SEPARATORS = ['是', '为', '為', 'は', '는', '은'];

// "mot de passe" is also written "mot-de-passe", and with no-break spaces.
const words = (list) => list.map((word) => word.replace(/ /g, String.raw`[\t\p{Zs}-]+`)).join('|');

/** "password", as a whole word, or one of its translations. Use with the "u" flag. */
export const PASSWORD_KEYWORD = String.raw`(?:(?<![\p{L}\p{N}])(?:${words(PASSWORD_WORDS)})(?![\p{L}\p{N}])|(?:${PASSWORD_WORDS_CJK.join('|')}))`;
// After the keyword: an optional closing quote or Markdown emphasis ("password": …, **Password**: …),
// then ":" or "=", a copula such as "is", "est" or "ist", or only blanks.
const KEYWORD_SEPARATOR = String.raw`(?:["']|\*\*|__)?(?:${S}*(?:[:=：]|=>|->|→)${S}*|${S}+(?:${COPULAS.join('|')})(?:${S}*[:：])?${S}+|${S}*(?:${CJK_SEPARATORS.join('|')})${S}*|${S}+)`;
const BT = '`';
// Unquoted values stop at CJK text, which is written without spaces: "密码是Abc12345登录".
const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}`;
const VALUE = String.raw`"[^"\n]+"|'[^'\n]+'|${BT}[^${BT}\n]+${BT}|«${S}*[^»\n]+?${S}*»|“[^”\n]+”|[^\s"'${BT},，。、«»“”${CJK}]+`;

/** Character classes of a value. `.`, `_` and `-` are too common in names to count as symbols. */
function charClasses(value) {
  const classes = { lower: /\p{Ll}/u.test(value), upper: /\p{Lu}/u.test(value), digit: /\p{N}/u.test(value), symbol: /[^\p{L}\p{N}._-]/u.test(value) };
  return { ...classes, count: Object.values(classes).filter(Boolean).length };
}

/**
 * Average length of the runs of lowercase letters, capitalized words, capitals and
 * digits in `token`. Names and words have long runs ("getUserById": 2.75 per run, more
 * for real words); random strings switch class every one or two characters.
 */
export function averageRun(token) {
  const runs = token.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? [];
  const letters = runs.reduce((total, run) => total + run.length, 0);
  return runs.length === 0 ? Infinity : letters / runs.length;
}

/**
 * A code identifier made of words, such as OAuth2Client, H264Decoder or UserId2: letters
 * and digits only, two words or more, and digits between words or at the end, never
 * inside a word as in "Passw0rd".
 */
export function looksLikeIdentifier(token) {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(token) || /\d[a-z]/.test(token)) return false;
  const parts = token.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? [];
  return parts.length >= 2 && parts.some((part) => part.length >= 3);
}

// Values that cannot be a password, whatever introduces them.
const NOT_A_PASSWORD = [
  /\[REDACTED:/,
  /:\/\//, // URL, or a Markdown link to one
  /^(?:~|\.{1,2})?[\\/]|^[A-Za-z]:[\\/]/, // absolute or relative path, slash command
  /^[\w.-]+(?:\/[\w.-]+)+\/?$/, // relative path
  WHOLE_EMAIL,
  /^v?\d+(?:\.\d+)+(?:[-+][\w.-]+)?$/i, // version
  /^[\d.,:/+-]+%?$/, // number, date, time, ratio
  /^(?:[\w.-]+\/[\w.-]+|PR|pr|issue|GH)?#\d+$/, // issue or pull request reference
  /\w\(.*\)$|\$\{|\{\{/, // function call, template
  /^[A-Za-z_$][\w.$]*[([]$/, // a call or subscript cut by a quote: env("…"), os.environ["…"]
  /^[A-Za-z_$][\w.$]*\[.*\]$/, // subscript
  /^[(\[{<].*[)\]}>]$|^</, // parenthesized, placeholder
  /^[A-Za-z_]\w*=/, // assignment
  /^--?[A-Za-z]/, // command-line flag
  /^\$\{?[A-Z_][A-Z0-9_]*\}?$/, // environment variable
  /^![A-Za-z]+$/, // YAML tag, such as !Ref
  /^\*+$/, // masked value
];

// Values that only look like something else when nothing says they are a password: after
// a keyword such as "password:", they are redacted.
const NOT_A_GUESSED_PASSWORD = [
  /^(?=.*\d)[0-9a-f-]{7,}$/, // commit SHA, UUID (lowercase: "Deadbeef1" is not one)
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, // UUID
  /^@[\w.-]+(?:\/[\w.-]+)?$/, // mention, scoped package
  /^(?:@[\w.-]+\/)?[a-z0-9][\w.-]*@[\^~]?v?(?:\d{1,2}|\d+(?:\.[\dx*]+)+)(?:[-+][\w.-]+)?$/, // package@version
  /^\$[A-Za-z_]\w*$/, // shell variable
  /^[\w-]+(?:\.[\w-]+)*\.[A-Za-z][A-Za-z0-9]{0,5}$/, // file or domain name
  /^[A-Za-z]+[ -]?v?\d+(?:\.\d+)+$/, // name and version: OAuth2.0, Python3.12
  /^[A-Z][A-Z0-9]+-\d+$/, // ticket: PROJ-1234, Q3-2024
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/, // ISO 8601 date and time
  /^\d{1,2}(?::\d{2}){1,2}(?:[ap]\.?m\.?)?$/i, // time of day
  /^[A-Za-z0-9][\w-]*:[#\w.-]+$/, // name:value, such as test:e2e, feat:Login or sha256:abc
  /^(?:[\w.-]+\/)?[\w.-]*#\d+$/, // slug and reference: fix-bug-#42, Fix#123
  /&&|\|\||[<>!=]=|=>|->/, // operators: node>=18, a&&b
  /^\p{L}+[!?.,]+\d{1,2}$/u, // a word, punctuation, then a stray digit: Hello!1
];

/**
 * Whether `token` (one word, no spaces) could be a password: long enough, not an ordinary
 * word (it has a digit or a symbol), mixing at least `minClasses` character classes, and
 * not a path, URL, version, flag or piece of code. With `guessed` (the default), nothing
 * says the token is a password, so hashes, file names, tickets and dates are left out too.
 */
export function looksLikePassword(token, { minLength = 6, minClasses = 2, guessed = true } = {}) {
  const value = token.replace(/[.,;:!?]+$/, '');
  if (value.length < minLength || value.length > 128 || /\s/.test(value)) return false;
  if (NOT_A_PASSWORD.some((pattern) => pattern.test(value))) return false;
  if (guessed && NOT_A_GUESSED_PASSWORD.some((pattern) => pattern.test(value))) return false;
  const classes = charClasses(value);
  return (classes.digit || classes.symbol) && classes.count >= minClasses;
}

/** A password on its own, with nothing around it to say so: it has to look random. */
function looksLikeLonePassword(token) {
  if (/^[a-z_][A-Za-z0-9_]*$/.test(token) || looksLikeIdentifier(token)) return false; // camelCase or PascalCase identifier
  return looksLikePassword(token, { minLength: 8, minClasses: 3 }) || looksLikePassword(token, { minLength: 6, minClasses: 4 });
}

/** A value that only sits next to an email: three classes, or a symbol, and not an identifier. */
function looksLikePasswordNextToEmail(token) {
  if (looksLikeIdentifier(token) || !looksLikePassword(token)) return false;
  const classes = charClasses(token.replace(/[.,;:!?]+$/, ''));
  return classes.count >= 3 || classes.symbol;
}

/** The quotes around a value, if any, and the value without them. */
function unquote(value) {
  const quotes = /^(["'`])[\s\S]*\1$/.exec(value)?.[1];
  if (quotes) return { open: quotes, close: quotes, bare: value.slice(1, -1) };
  const guillemets = /^(«[\t\p{Zs}]*)[\s\S]*?([\t\p{Zs}]*»)$/u.exec(value);
  if (guillemets) return { open: guillemets[1], close: guillemets[2], bare: value.slice(guillemets[1].length, value.length - guillemets[2].length) };
  if (/^“[\s\S]*”$/.test(value)) return { open: '“', close: '”', bare: value.slice(1, -1) };
  return { open: '', close: '', bare: value };
}

/** The value after a password keyword. Strictness depends on how it was introduced. */
function acceptKeywordValue(value, groups) {
  const { bare } = unquote(value);
  const keyword = groups.keyword.toLowerCase();
  const onlyBlanks = /^[\t\p{Zs}]+$/u.test(groups.sep);
  if (AMBIGUOUS_WORDS.has(keyword)) {
    // "pass MyComponent2 as a prop", "first pass: Step1Done", "clave: UserId2"
    if (onlyBlanks || looksLikeIdentifier(bare)) return false;
    if (VERB_WORDS.has(keyword)) return looksLikePassword(bare, { minLength: 6, minClasses: 3, guessed: false });
  } else if (onlyBlanks) return looksLikeLonePassword(bare);
  if (/^\d{6,}$/.test(bare)) return true;
  return looksLikePassword(bare, { minLength: 4, minClasses: 2, guessed: false });
}

/**
 * A session ID or other cookie value: long, with digits, and random-looking (hex, or
 * switching character class all the time), unlike "production-cluster-1".
 */
const acceptSessionValue = (value) =>
  value.length >= 16 && /\d/.test(value) && charClasses(value).count >= 2 && (/^[0-9a-f-]+$/i.test(value) || averageRun(value) < 2.5);

/**
 * Whether the line around a match also holds a password after a keyword, or one already
 * redacted: an email on that line is part of the credentials.
 */
function onCredentialLine({ input, index, length }) {
  const start = input.lastIndexOf('\n', index) + 1;
  const end = input.indexOf('\n', index + length);
  const line = input.slice(start, end < 0 ? input.length : end);
  if (line.includes('[REDACTED:password]')) return true;
  return [...line.matchAll(KEYWORD_RULE.pattern)].some((match) => acceptKeywordValue(match.groups.secret, match.groups));
}

// Separators between an email and a password. ":", "|" and " / " say "this is a pair",
// so the password is checked as after a keyword; blanks, commas and dashes need more.
const PAIR_SEPARATOR = /^[\t\p{Zs}]*[:|][\t\p{Zs}]*$|^[\t\p{Zs}]+\/[\t\p{Zs}]+$/u;

// "password: …", "mot de passe : …", "das Passwort ist …", "密码是…"
const KEYWORD_RULE = {
  kind: 'password',
  pattern: new RegExp(String.raw`(?<pre>(?<keyword>${PASSWORD_KEYWORD})(?<sep>${KEYWORD_SEPARATOR}))(?<secret>${VALUE})`, 'giu'),
  accept: acceptKeywordValue,
  render: (groups) => {
    const { open, close } = unquote(groups.secret);
    return `${groups.pre}${open}[REDACTED:password]${close}`;
  },
};

const RULES = [
  { kind: 'private-key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { kind: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai-key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { kind: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: 'stripe-key', pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  // Login links npm prints while it waits for two-factor authentication.
  { kind: 'npm-auth-link', pattern: /(?<pre>https:\/\/www\.npmjs\.com\/auth\/cli\/)(?<secret>[A-Za-z0-9-]{16,})/g },
  { kind: 'npm-auth-link', pattern: /(?<pre>\/-\/v1\/done\?authId=)(?<secret>[A-Za-z0-9-]{16,})/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: 'bearer-token', pattern: /(?<pre>\bBearer\s+)(?<secret>[A-Za-z0-9._~+/-]{20,}=*)/g },
  // Environment-style assignments: GITHUB_TOKEN=..., "DB_PASSWORD": "...", export API_KEY='...'
  {
    kind: 'secret',
    pattern: /(?<pre>\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY)[A-Z0-9_]*["']?\s*[:=]\s*["']?)(?<secret>[^\s"'`,;)]{8,})/g,
  },
  // Cookies: a Cookie or Set-Cookie header, also as a key of a headers object ({ "Cookie": "…" }),
  // document.cookie, a --cookie argument, curl's -b, and session parameters.
  {
    kind: 'cookie',
    pattern: /(?<pre>(?:\b(?:Set-)?Cookie["']?[ \t]*:|\bdocument\.cookie[ \t]*=)[ \t]*(?<quote>["'`]?))(?<secret>[^\n"'`]+)(?<post>\k<quote>)/gi,
    accept: (value) => /[^\s=;]+=[^\s;]{8,}/.test(value),
  },
  {
    kind: 'cookie',
    pattern: /(?<pre>\bcookies?[ \t]+(?:is|was|est|ist|es)[ \t]+)(?<secret>[^\s"'`]+)/gi,
    accept: (value) => /^[^\s=;]+=[^\s;]{8,}/.test(value),
  },
  {
    kind: 'cookie',
    pattern: /(?<pre>(?:--cookie|\bcurl\b[^\n]*?[ \t]-b)(?:=|[ \t]+)(?<quote>["']?))(?<secret>(?:(?!\k<quote>)[^\n])+?|[^\s"']+)(?<post>\k<quote>)(?=$|[\s;|&)])/gm,
    accept: (value, groups) => value.length >= 8 && (value.includes('=') || (groups.pre.includes('--cookie') && value.length >= 16)),
  },
  {
    kind: 'cookie',
    pattern: /(?<pre>(?<![\w.-])(?:connect\.sid|PHPSESSID|JSESSIONID|ASP\.NET_SessionId|[\w.-]*session(?:[_-]?(?:id|token|key))?|[\w.-]*(?:auth|remember)[_-]?token|sessid|ssid|sid)=)(?<secret>[A-Za-z0-9%._~+/:=-]+)/gi,
    accept: acceptSessionValue,
  },
  // Passwords in URLs: https://user:password@host
  { kind: 'password', pattern: /(?<pre>(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@]*:)(?<secret>[^\s/@]+)(?=@)/gi },
  // An email followed by a password, as in "log in with jane@example.com Tr0ub4dor&3",
  // "jane@example.com / hunter22" or "`jane@example.com`, `Tr0ub4dor&3`".
  {
    kind: 'password',
    also: 'email',
    pattern: new RegExp(String.raw`(?<open>["'${BT}]?)(?<email>${EMAIL})\k<open>(?<sep>${S}*[:|,;]${S}*|${S}*\/${S}*|${S}+[—–-]${S}+|${S}+)(?<quote>["'${BT}]?)(?<secret>[^\s"'${BT}]+)\k<quote>`, 'gu'),
    accept: (value, groups) => (PAIR_SEPARATOR.test(groups.sep) ? looksLikePassword(value) : looksLikePasswordNextToEmail(value)),
    render: (groups) => `${groups.open}[REDACTED:email]${groups.open}${groups.sep}${groups.quote}[REDACTED:password]${groups.quote}`,
  },
  // The same on two lines, as pasted credentials: an email alone on its line, and a password alone on the next.
  {
    kind: 'password',
    also: 'email',
    pattern: new RegExp(String.raw`(?<pre>(?:^|\n)${S}*)(?<open>["'${BT}]?)(?<email>${EMAIL})\k<open>(?<sep>${S}*\r?\n${S}*)(?<quote>["'${BT}]?)(?<secret>[^\s"'${BT}]+)\k<quote>(?=${S}*(?:\r?\n|$))`, 'gu'),
    accept: (value) => looksLikePasswordNextToEmail(value),
    render: (groups) => `${groups.pre}${groups.open}[REDACTED:email]${groups.open}${groups.sep}${groups.quote}[REDACTED:password]${groups.quote}`,
  },
  KEYWORD_RULE,
  // An email on the same line as a password: "user: jane@example.com pass: Tr0ub4dor&3".
  { kind: 'email', pattern: new RegExp(EMAIL, 'g'), accept: (value, groups, context) => !/^git@/i.test(value) && onCredentialLine(context) },
];

const EMAIL_RULE = { kind: 'email', pattern: new RegExp(EMAIL, 'g'), accept: (value) => !/^git@/i.test(value) };

// Home directories. The user name becomes "~"; shared directories are left alone. A
// Windows user name can have spaces ("C:\Users\Jane Doe\…"), taken when a separator follows.
const NAME = String.raw`[\p{L}\p{N}._-]+`;
const WINDOWS_NAME = String.raw`(?!(?:Public|Default|Default User|All Users)(?![\p{L}\p{N}._ -]))${NAME}(?:(?: ${NAME})+(?=[\\/"'${BT}]))?(?![\p{L}\p{N}._-])`;
/** /mnt/c/Users/<name> (WSL), C:\Users\<name> (or C:/Users/<name>), /Users/<name> and /home/<name>. */
export const HOME_PATHS = [
  new RegExp(String.raw`(?<![\w.~-])\/mnt\/[a-z]\/Users\/${WINDOWS_NAME}`, 'giu'),
  new RegExp(String.raw`(?<![\w.-])[A-Za-z]:(?<sep>\\{1,2}|\/)Users\k<sep>${WINDOWS_NAME}`, 'giu'),
  new RegExp(String.raw`(?<![\w.~-])\/(?:Users|home)\/(?!(?:Shared|linuxbrew)(?![\p{L}\p{N}._-]))${NAME}(?![\p{L}\p{N}._-])`, 'gu'),
];

/**
 * The named groups of a `String.replace` callback's arguments, and where the match is:
 * { groups, context: { input, index, length } }.
 */
function matchOf(args) {
  const named = typeof args.at(-1) === 'object';
  const input = named ? args.at(-2) : args.at(-1);
  const index = named ? args.at(-3) : args.at(-2);
  return { groups: named ? args.at(-1) : {}, context: { input, index, length: args[0].length } };
}

/** Runs one rule over `text`, calling `found(kind)` for each value it replaces. */
function applyRule(text, rule, found) {
  return text.replace(rule.pattern, (...args) => {
    const match = args[0];
    const { groups, context } = matchOf(args);
    const value = groups.secret ?? match;
    if (value.startsWith('[REDACTED:')) return match;
    if (rule.accept && !rule.accept(value, groups, context)) return match;
    found(rule.kind);
    if (rule.also) found(rule.also);
    if (rule.render) return rule.render(groups);
    return `${groups.pre ?? ''}[REDACTED:${rule.kind}]${groups.post ?? ''}`;
  });
}

/**
 * The rules that apply with these options, in order. `emails` (off by default) also
 * redacts every email address, not only those next to a password.
 */
function rulesFor({ emails = false } = {}) {
  return emails ? [...RULES, EMAIL_RULE] : RULES;
}

/** A prompt that is nothing but an email address or a password. */
function redactLoneCredential(text, found) {
  const token = text.trim();
  if (/\s/.test(token) || token === '' || token.startsWith('[REDACTED:')) return text;
  if (WHOLE_EMAIL.test(token)) return (found('email'), '[REDACTED:email]');
  if (looksLikeLonePassword(token)) return (found('password'), '[REDACTED:password]');
  return text;
}

/** Replaces the home directories of HOME_PATHS with "~". Returns the text and a count. */
export function anonymizeHomePaths(text) {
  let count = 0;
  let result = text;
  for (const pattern of HOME_PATHS) result = result.replace(pattern, () => (count++, '~'));
  return { text: result, count };
}

/**
 * Replaces secrets in `text` with `[REDACTED:<kind>]`.
 * Options come from the "redact" object of `.open-prompts.json`:
 * - `emails` (default false): redact every email address.
 * - `homePaths` (default true): replace home directories with "~".
 * Returns the new text, the kinds of secrets that were found, and how many home
 * directories were replaced, which is not a secret and so is not in `kinds`.
 */
export function redact(text, options = {}) {
  const kinds = [];
  const found = (kind) => kinds.push(kind);
  let result = text;
  for (const rule of rulesFor(options)) result = applyRule(result, rule, found);
  result = redactLoneCredential(result, found);
  let homePaths = 0;
  if (options.homePaths !== false) ({ text: result, count: homePaths } = anonymizeHomePaths(result));
  return { text: result, kinds, homePaths };
}

/**
 * Finds what `redact` would replace, without replacing it, for `open-prompts audit`.
 * Returns [{ kind, index, length }], in the order of the text, without overlaps.
 */
export function findSecrets(text, options = {}) {
  const findings = [];
  const overlaps = (start, end) => findings.some((f) => start < f.index + f.length && f.index < end);
  for (const rule of rulesFor(options)) {
    for (const match of text.matchAll(rule.pattern)) {
      const groups = match.groups ?? {};
      const value = groups.secret ?? match[0];
      const context = { input: text, index: match.index, length: match[0].length };
      if (value.startsWith('[REDACTED:') || (rule.accept && !rule.accept(value, groups, context))) continue;
      // An email and its password are one finding; otherwise only the value counts.
      const start = match.index + (groups.pre?.length ?? 0);
      const end = match.index + match[0].length - (rule.also ? 0 : (groups.post?.length ?? 0));
      if (!overlaps(start, end)) findings.push({ kind: rule.also ? `${rule.also}-and-${rule.kind}` : rule.kind, index: start, length: end - start });
    }
  }
  const token = text.trim();
  if (findings.length === 0) {
    let kind = null;
    redactLoneCredential(token, (found) => (kind = found));
    if (kind) findings.push({ kind, index: text.indexOf(token), length: token.length });
  }
  return findings.sort((a, b) => a.index - b.index);
}
