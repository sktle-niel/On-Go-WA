#!/usr/bin/env node
/**
 * Secret scanner for commits, pushes and CI. No dependencies.
 *
 *   node scripts/check-secrets.mjs --staged     files staged for commit (pre-commit hook)
 *   node scripts/check-secrets.mjs --all        every tracked file (pre-push hook, CI)
 *   node scripts/check-secrets.mjs <path …>     specific files
 *
 * Exits 1 when anything looks like a credential or key material. Matched
 * values are never printed in full. A line that is a known false positive may
 * carry the marker `not-a-secret` in a comment, with a reason; use that
 * sparingly. Never bypass the hooks with --no-verify.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MARKER = 'not-a-secret';
const MAX_BYTES = 1_000_000;

/** Files that must never be committed, whatever they contain. */
const FORBIDDEN_PATHS = [
  { re: /(^|\/)\.env(\..+)?$/, unless: /(^|\/)\.env\.example$/, why: 'environment file' },
  { re: /\.(pem|key|p12|pfx|jks|keystore|asc|gpg|ppk)$/i, why: 'key or certificate material' },
  { re: /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/, why: 'SSH key' },
  { re: /(^|\/)(credentials|service[-_]?account[^/]*|client_secret[^/]*)\.json$/i, why: 'cloud credential file' },
  { re: /(^|\/)\.npmrc$/, why: 'npm auth file' },
];

/** Files not worth scanning (generated, binary, or hashes that look like keys). */
const SKIP_PATHS = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /\.(png|jpe?g|gif|webp|ico|pdf|docx?|xlsx?|zip|gz|tgz|woff2?|ttf|eot|wasm|mp[34]|mov)$/i,
];

/** Well-known credential shapes. */
const PATTERNS = [
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Google OAuth client secret', re: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { name: 'Slack token', re: /\bxox[abpr]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'Stripe key', re: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/ },
  { name: 'Mailgun key', re: /\bkey-[0-9a-f]{32}\b/ },
  { name: 'SendGrid key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/ },
  { name: 'Twilio key', re: /\bSK[0-9a-fA-F]{32}\b/ },
  { name: 'Neon / pg password', re: /\bnpg_[A-Za-z0-9]{12,}\b/ },
  { name: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { name: 'connection URL with password', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:/@]+:[^\s@]+@/i },
  { name: 'Anthropic / OpenAI style key', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/ },
];

/**
 * `PASSWORD=…`, `secret: "…"`, `apiToken = '…'`: a key whose name contains a
 * credential word, followed by a LITERAL value of 16+ token characters
 * (letters, digits, `_ - + / =`) that ends at a quote, space or delimiter.
 * Expressions (`config.PGPASSWORD`, `hash(plaintext)`) never match because
 * `.` and `(` are neither value characters nor terminators. Obvious
 * placeholders are allowed (see PLACEHOLDER); a value made of one character
 * class only (`=====`, `aaaaaaaa`) is not a secret.
 */
const ASSIGNMENT =
  /\b[A-Za-z0-9_]*?(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|signing[_-]?key|pepper|client[_-]?secret)[A-Za-z0-9_]*[ \t]*[:=][ \t]*['"`]?([A-Za-z0-9_\-+/=]{16,})(?=$|['"`\s,;)}\]|])/i;
const PLACEHOLDER =
  /^(?:\$\{|\$[A-Z_]|<|\.\.\.|…)|xxx|example|placeholder|replace|your[-_]|not[-_]a[-_]real|dummy|change[-_]?me|^test[-_]|[-_]test\b|sample|fake|redacted|\*\*\*|^ongo-[a-z-]+:latest$|^[A-Z_]+$/i;

function characterClasses(value) {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
}

function listFiles(mode) {
  const args =
    mode === 'staged'
      ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
      : ['ls-files', '-z'];
  return git(args).toString('utf8').split('\0').filter(Boolean);
}

function readContent(file, mode) {
  // Staged mode reads what will actually be committed, not the working copy.
  return mode === 'staged' ? git(['show', `:${file}`]) : readFileSync(file);
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

function mask(value) {
  return `${value.slice(0, 3)}… (${value.length} chars)`;
}

function scan(file, buf) {
  const findings = [];
  const forbidden = FORBIDDEN_PATHS.find((rule) => rule.re.test(file) && !(rule.unless && rule.unless.test(file)));
  if (forbidden) {
    findings.push({ file, line: 0, rule: `forbidden file (${forbidden.why})`, value: '' });
    return findings;
  }
  if (SKIP_PATHS.some((re) => re.test(file)) || buf.length > MAX_BYTES || isBinary(buf)) return findings;

  const lines = buf.toString('utf8').split(/\r?\n/);
  lines.forEach((text, index) => {
    if (text.includes(MARKER)) return;
    for (const { name, re } of PATTERNS) {
      const match = re.exec(text);
      if (match) findings.push({ file, line: index + 1, rule: name, value: mask(match[0]) });
    }
    const assignment = ASSIGNMENT.exec(text);
    if (assignment && !PLACEHOLDER.test(assignment[1]) && characterClasses(assignment[1]) >= 2) {
      findings.push({ file, line: index + 1, rule: 'credential-like assignment', value: mask(assignment[1]) });
    }
  });
  return findings;
}

function main(argv) {
  let mode = 'paths';
  let files = [];
  if (argv[0] === '--staged') mode = 'staged';
  else if (argv[0] === '--all') mode = 'all';
  else if (argv.length > 0) files = argv;
  else {
    console.error('usage: check-secrets.mjs --staged | --all | <path …>');
    return 2;
  }
  if (mode !== 'paths') files = listFiles(mode);

  const findings = [];
  for (const file of files) {
    let buf;
    try {
      buf = readContent(file, mode);
    } catch {
      continue; // deleted, or a submodule
    }
    findings.push(...scan(file, buf));
  }

  if (findings.length === 0) {
    console.log(`secret scan: ${files.length} file(s), nothing found`);
    return 0;
  }
  console.error(`secret scan: ${findings.length} finding(s) in ${files.length} file(s)\n`);
  for (const f of findings) {
    console.error(`  ${f.file}${f.line ? `:${f.line}` : ''}  ${f.rule}${f.value ? `  ${f.value}` : ''}`);
  }
  console.error(
    '\nA real secret: remove it, rotate it, and keep it in Secret Manager or a git-ignored .env file.' +
      `\nA false positive: add a comment with "${MARKER}" and the reason on that line.` +
      '\nNever commit with --no-verify. See SECURITY.md.',
  );
  return 1;
}

process.exit(main(process.argv.slice(2)));
