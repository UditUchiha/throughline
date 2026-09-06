/**
 * The conventions gate (PLAN.md §0.3, §3; M6.3's CI job).
 *
 *   pnpm check:conventions
 *
 * Enforces the four rules that are stated as prose in CLAUDE.md and have, until
 * now, been checked by whoever remembered to check them. Exits non-zero on a
 * violation and names the file and line.
 *
 * Two design notes worth reading before changing anything here.
 *
 * **The `process.env` rule is about reads, not occurrences.** HANDOFF predicted
 * this gate would land red on day one, because a naive grep finds three hits that
 * are all legitimate. `langsmith-tracing.service.ts` *writes* `LANGSMITH_*` back
 * into the environment for LangGraph and the LangSmith wrapper to read — every
 * value comes from `AppConfigService` and every variable is declared in
 * `env.schema.ts` first — so a read/write distinction clears it automatically.
 * The other two are genuine reads and carry explicit, justified exemptions below.
 *
 * **`evals/` is checked for `process.env` and singletons, but not for `console`.**
 * `evals/` is a runner: it boots the real `AppModule`, which makes it the closest
 * thing to application code outside `src/`, but it also has to *configure* that
 * boot before it happens. Setting `DATABASE_PATH`, `DEMO_MODE` and `MCP_SERVERS`
 * from the command line is the only way to point a Nest context that has not
 * started yet — and those are *writes*, which the read/write distinction already
 * clears without needing an exemption. A CLI reports through stdout, so
 * `console.*` is its logger and rule 2 stays scoped to `src/`.
 *
 * The `process.env` rule covering `evals/` at all is a correction. It used to be
 * `src/`-only, which meant the harness's one genuine read was not permitted so
 * much as unobserved — and the difference matters, because the next read added
 * there would have been unobserved too. Being in a runner is a reason for an
 * exemption to be granted, not a reason for the rule not to apply.
 *
 * What does *not* get a pass anywhere is a module-level singleton, so rule 3
 * covers both trees.
 *
 * **The client-identifier list is read out of PLAN.md rather than written here.**
 * If this file spelled the identifiers out it would fail its own check, and a
 * gate that has to exempt itself is one nobody trusts. PLAN.md §3 is where they
 * are defined, so §3 is where they are read from — and note that §3 says two
 * further identifiers are deliberately no longer spelled out, which means this
 * gate covers the two that are named and no more. That is a real limit, not an
 * oversight: the full check needs the strings from the repo owner.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');
const EVALS = join(ROOT, 'evals');

/**
 * Files allowed to read `process.env` outside `src/config/`, with the reason.
 *
 * Both are plumbing rather than configuration: neither reads a value the
 * application then behaves differently because of, in the way `AppConfigService`
 * exists to mediate. Adding to this list should be rare and should come with a
 * sentence that survives review.
 */
const PROCESS_ENV_EXEMPTIONS = new Map([
  [
    'src/logger/logger.module.ts',
    'reads NODE_ENV to pick a Pino transport. Long-standing, and the logger is ' +
      'constructed before AppConfigService exists.',
  ],
  [
    'src/integrations/mcp/mcp-host.service.ts',
    'passes the ambient environment to an stdio child process. It reads the whole ' +
      'environment as a value to forward, not a setting to act on.',
  ],
  [
    'evals/harness/context.ts',
    'reads DATABASE_PATH to decide which database to copy the eval index from. ' +
      'It runs before NestFactory, so AppConfigService does not exist yet — that ' +
      'is the point of the read rather than a way around it. The default it falls ' +
      'back to is imported from env.schema.ts, not written out again.',
  ],
]);

/**
 * Generated artifacts whose contents are machine data, not text.
 *
 * The client-identifier rule matches case-insensitively against every line of
 * every tracked file, which is right for anything a person wrote and meaningless
 * against base64: one of the two identifiers PLAN.md §3 names is four characters
 * long, and a four-character string turns up inside a 4096-character base64 blob
 * routinely. `corpus/index/embeddings.json` is 172 such blobs, and one of them
 * hit — in the wrong case, surrounded by base64 alphabet, in a file that contains
 * no prose at all.
 *
 * The exemption is **conditional on the file still being machine data**, checked
 * by `looksGenerated` below rather than taken on trust. That matters more here
 * than anywhere else in this file: a blanket path skip on a public-repo gate is
 * exactly how a real leak gets waved through later, and this way a file that
 * gains a description field, a comment, or any human-written string stops
 * qualifying and is checked like everything else.
 */
const GENERATED_DATA_FILES = new Map([
  [
    'corpus/index/embeddings.json',
    'sha256 keys and base64 float32 vectors — the committed artifact that makes ' +
      "the Docker index build keyless (PLAN.md §9). No line of it is anyone's prose.",
  ],
]);

/**
 * True when every string in the file is a hash or a base64 payload.
 *
 * Deliberately strict: the metadata keys the artifact does carry (`modelId`,
 * `generatedAt`) are matched by name, so adding a free-text field to the format
 * fails this check and revokes the exemption automatically.
 */
function looksGenerated(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;

  const vectors = parsed.vectors;
  if (typeof vectors !== 'object' || vectors === null) return false;

  const entries = Object.entries(vectors);
  if (entries.length === 0) return false;

  const machineData = entries.every(
    ([key, value]) =>
      /^[0-9a-f]{64}$/.test(key) && typeof value === 'string' && /^[A-Za-z0-9+/=]+$/.test(value),
  );

  const knownScalars = ['modelId', 'dimensions', 'generatedAt', 'vectors'];
  const onlyKnownKeys = Object.keys(parsed).every((key) => knownScalars.includes(key));

  return machineData && onlyKnownKeys;
}

/** Strips comments and string literals so a rule cannot fire on prose or a regex. */
function stripNonCode(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (match, prefix) => prefix + ' '.repeat(match.length - prefix.length),
    )
    .replace(/`(?:\\.|[^`\\])*`/g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/'(?:\\.|[^'\\\n])*'/g, (match) => ' '.repeat(match.length))
    .replace(/"(?:\\.|[^"\\\n])*"/g, (match) => ' '.repeat(match.length));
}

function walk(dir) {
  const found = [];
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.isFile() && extname(entry.name) === '.ts') found.push(full);
  }
  return found;
}

function relativePath(full) {
  return relative(ROOT, full).split('\\').join('/');
}

const violations = [];

function violate(rule, file, line, detail) {
  violations.push({ rule, file, line, detail });
}

// --- Rule 1: no process.env READS outside src/config/ (src/ AND evals/) -------

const PROCESS_ENV = /process\.env(?:\.(\w+)|\[[^\]]+\])?/g;

for (const full of [...walk(SRC), ...walk(EVALS)]) {
  const file = relativePath(full);
  if (file.startsWith('src/config/')) continue;

  const code = stripNonCode(readFileSync(full, 'utf8'));
  const lines = code.split('\n');

  lines.forEach((text, index) => {
    for (const match of text.matchAll(PROCESS_ENV)) {
      const after = text.slice(match.index + match[0].length);
      // A write is `process.env.X = value`. Everything else — a read, a spread, a
      // comparison — is what the rule is about. `==`, `===` and `=>` are reads.
      const isWrite = /^\s*=(?![=>])/.test(after);
      if (isWrite) continue;
      if (PROCESS_ENV_EXEMPTIONS.has(file)) continue;

      violate(
        'process.env read outside src/config/',
        file,
        index + 1,
        `${match[0]} — add the variable to src/config/env.schema.ts and read it through AppConfigService`,
      );
    }
  });
}

for (const [file] of GENERATED_DATA_FILES) {
  // Same reasoning as the PROCESS_ENV_EXEMPTIONS sweep below: an exemption naming
  // a file that no longer exists is a rule quietly getting narrower.
  if (!existsSync(join(ROOT, file))) {
    violate('stale exemption', 'scripts/check-conventions.mjs', 0, `${file} no longer exists`);
  }
}

for (const [file] of PROCESS_ENV_EXEMPTIONS) {
  // An exemption for a file that no longer exists is a rule quietly getting
  // weaker, so it is an error rather than something to ignore.
  try {
    statSync(join(ROOT, file));
  } catch {
    violate('stale exemption', 'scripts/check-conventions.mjs', 0, `${file} no longer exists`);
  }
}

// --- Rule 2: no console.* in src/ (use the Nest Logger) -----------------------

for (const full of walk(SRC)) {
  const file = relativePath(full);
  // Specs print nothing, but a spec asserting on console output is legitimate.
  if (file.endsWith('.spec.ts')) continue;

  const code = stripNonCode(readFileSync(full, 'utf8'));
  code.split('\n').forEach((text, index) => {
    const match = /\bconsole\.(log|info|warn|error|debug|trace)\b/.exec(text);
    if (match) {
      violate('console.* in src/', file, index + 1, `${match[0]} — use the NestJS Logger`);
    }
  });
}

// --- Rule 3: no module-level singletons (src/ AND evals/) ---------------------

for (const full of [...walk(SRC), ...walk(EVALS)]) {
  const file = relativePath(full);
  if (file.endsWith('.spec.ts')) continue;

  const code = stripNonCode(readFileSync(full, 'utf8'));
  code.split('\n').forEach((text, index) => {
    if (/^export\s+const\s+\w+\s*(?::[^=]+)?=\s*new\s+[A-Z]/.test(text)) {
      violate(
        'module-level singleton',
        file,
        index + 1,
        'make it @Injectable() and wire it through Nest DI',
      );
    }
  });
}

// --- Rule 4: no client identifiers in any tracked file except PLAN.md ---------

/**
 * The two identifiers PLAN.md §3 still names. Read from the document rather than
 * duplicated here — see the header.
 */
function clientIdentifiersFromPlan() {
  const plan = readFileSync(join(ROOT, 'PLAN.md'), 'utf8');
  const match = /Grep for `([a-z0-9_-]+)` and `([a-z0-9_-]+)`/i.exec(plan);
  if (!match) {
    violate(
      'client-identifier list',
      'PLAN.md',
      0,
      '§3 no longer names the identifiers in the expected form; this gate cannot run',
    );
    return [];
  }
  return [match[1], match[2]];
}

const identifiers = clientIdentifiersFromPlan();

if (identifiers.length > 0) {
  // Tracked **and** untracked-but-not-ignored. `git ls-files` alone would check
  // only what is already committed, which on a public repo means the gate first
  // sees a leaked identifier one commit after it mattered. The whole point is to
  // cover what you are about to commit.
  const listed = [
    execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }),
    execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: ROOT,
      encoding: 'utf8',
    }),
  ].join('\n');

  const tracked = [
    ...new Set(
      listed
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ].filter((file) => file !== 'PLAN.md' && file !== 'scripts/check-conventions.mjs');

  const pattern = new RegExp(identifiers.join('|'), 'i');

  for (const file of tracked) {
    let content;
    try {
      content = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      // Binary or unreadable: nothing to match, and a lockfile is not worth failing on.
      continue;
    }

    // Earned each run, not granted once — see GENERATED_DATA_FILES. A listed file
    // that stops looking generated is checked like any other rather than skipped.
    if (GENERATED_DATA_FILES.has(file) && looksGenerated(content)) continue;

    content.split('\n').forEach((text, index) => {
      if (pattern.test(text)) {
        violate(
          'client identifier in a tracked file',
          file,
          index + 1,
          'PLAN.md §3 — these must appear in no tracked file except PLAN.md itself',
        );
      }
    });
  }
}

// --- Report -------------------------------------------------------------------

if (violations.length === 0) {
  console.log(
    `conventions: ok — process.env reads and console.* in src/, singletons in src/ and evals/, ` +
      `client identifiers across ${identifiers.length > 0 ? 'tracked and untracked files' : '(list unavailable)'}`,
  );
  process.exit(0);
}

console.error(`\nconventions: ${violations.length} violation(s)\n`);
for (const violation of violations) {
  console.error(`  ${violation.file}:${violation.line}`);
  console.error(`    [${violation.rule}] ${violation.detail}\n`);
}
console.error(
  'These are PLAN.md §0.3 and §3. If a violation is genuinely correct, add it to the\n' +
    'exemption list in scripts/check-conventions.mjs with a sentence saying why.\n',
);
process.exit(1);
