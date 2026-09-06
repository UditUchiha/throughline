/**
 * Expands corpus/ledger/{entities,facts,documents}.yaml into the natural-language
 * documents committed under corpus/generated/{mail,chat,notes}/. See PLAN.md §6.
 *
 * This is a one-off authoring tool, not a runtime dependency of the app — it is run
 * once (or re-run when the ledger changes) and its output is committed to the repo,
 * so a fresh clone works with no generation step. It runs outside the NestJS app
 * context entirely (no DI, no AppConfigService), consistent with how this project's
 * prior one-off scripts worked.
 *
 * Usage:
 *   pnpm corpus:generate                  # generate everything
 *   pnpm corpus:generate --only=mail       # only one source type
 *   pnpm corpus:generate --only=fact.helios-owner   # only docs touching one fact
 *   pnpm corpus:generate --dry-run         # print prompts, call nothing, write nothing
 *   pnpm corpus:generate --verify-only    # re-check corpus on disk, no model calls
 *
 * A document with a `verbatim` body in documents.yaml is written straight to disk with
 * no model call and no rate-limit delay — see the VerbatimBody type below for why the
 * adversarial set works that way.
 *
 * Requires GEMINI_API_KEY in the environment (see .env.example). Uses Gemini because
 * it's fast, has a generous free tier, and matches the provider the author intends to
 * use as this project's default cloud LLM (PLAN.md §11.3) — but this script is not
 * part of the app's own provider abstraction (that's PLAN.md M1), so it talks to
 * Gemini directly rather than through any app code.
 *
 * Verification pass (PLAN.md §6 "Generator"): PLAN.md suggests checking fact survival
 * via embedding similarity. This script instead extracts hard, checkable details from
 * each fact statement — ISO dates, dollar amounts, multiplier figures ("4x"), and any
 * known entity name the fact statement itself mentions — and verifies each literally
 * appears in the generated document. This is a deliberate departure from the plan's
 * suggested method: an embedding-similarity threshold is a fuzzy topical-relevance
 * proxy and requires picking an arbitrary cutoff, whereas "did the exact date/name/
 * amount survive" is the actual failure mode worth catching, and it's fully
 * deterministic — no embedding calls, no threshold to tune. Anything that fails is
 * reported for manual review rather than silently accepted or hard-failed.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import * as yaml from 'js-yaml';

const LEDGER_DIR = resolve(__dirname, '../corpus/ledger');
const OUTPUT_DIR = resolve(__dirname, '../corpus/generated');
const REPORT_PATH = resolve(__dirname, '../corpus/.generation-report.json');

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CONCURRENCY = Number(process.env.CORPUS_GENERATE_CONCURRENCY ?? 1);
const MAX_RETRIES = 4;

// ---------------------------------------------------------------------------
// Types (mirror corpus/ledger/*.yaml — not the app's own domain types, since
// this script runs standalone and never touches src/).
// ---------------------------------------------------------------------------

interface Entities {
  company: { id: string; name: string; description: string };
  product: { id: string; name: string; description: string };
  people: { id: string; name: string; role: string }[];
  customers: { id: string; name: string; description: string }[];
  projects: { id: string; name: string; description: string }[];
  channels: string[];
}

interface Fact {
  id: string;
  statement: string;
  expressedIn: string[];
  supersedes: string | null;
}

/**
 * Body text to use instead of calling the model, for documents whose exact
 * wording is the point (M5's adversarial set — see `adversarial: true` in
 * documents.yaml).
 *
 * An injection payload has to be byte-exact for resistance to mean anything: the
 * eval suite scores whether a specific instruction was obeyed and whether a
 * specific marker string reached the answer, and a model asked to write an attack
 * string will paraphrase it, soften it, or decline. Laundering the attack through
 * the generator would make the corpus's most security-relevant documents the only
 * ones nobody can predict.
 *
 * This does not weaken the ledger-first rule (PLAN.md §6). The fact is still
 * authored before the document, documents.yaml still assigns it, and the literal-
 * token verifier still checks that it survived. Only the prose stops being
 * generated — which PLAN.md §12.2 already permits for hand-editing, made explicit
 * and principled here rather than done quietly afterwards.
 */
interface VerbatimBody {
  verbatim?: string;
  /** Marks a document written to attack the reader. Documentation, not behaviour. */
  adversarial?: boolean;
}

interface MailDoc extends VerbatimBody {
  docId: string;
  threadId: string;
  subject: string;
  from: string;
  to: string[];
  date: string;
  factIds: string[];
  brief: string;
}

interface ChatDoc extends VerbatimBody {
  docId: string;
  channel: string;
  date: string;
  participants: string[];
  factIds: string[];
  brief: string;
}

interface NoteDoc extends VerbatimBody {
  docId: string;
  title: string;
  tags: string[];
  updated: string;
  factIds: string[];
  brief: string;
}

interface Documents {
  mail: MailDoc[];
  chat: ChatDoc[];
  notes: NoteDoc[];
}

type AnyDoc = MailDoc | ChatDoc | NoteDoc;
type SourceType = 'mail' | 'chat' | 'notes';

interface GenerationReportEntry {
  docId: string;
  source: SourceType;
  path: string;
  factIds: string[];
  verification: { token: string; found: boolean }[];
  needsReview: boolean;
}

// ---------------------------------------------------------------------------
// Load + validate
// ---------------------------------------------------------------------------

// JSON_SCHEMA (not the default schema) is required here: js-yaml's default schema
// implicitly resolves unquoted YYYY-MM-DD scalars to native Date objects (a YAML 1.1
// timestamp type), which then stringify as verbose locale strings ("Thu Feb 19 2026
// 05:30:00 GMT+0530...") the moment they're interpolated into a prompt or frontmatter
// line. JSON_SCHEMA has no timestamp type, so every date in the ledger stays the
// plain "2026-02-19" string it's written as.
function loadYaml<T>(filename: string): T {
  return yaml.load(readFileSync(resolve(LEDGER_DIR, filename), 'utf-8'), {
    schema: yaml.JSON_SCHEMA,
  }) as T;
}

function loadLedger() {
  const entities = loadYaml<Entities>('entities.yaml');
  const { facts } = loadYaml<{ facts: Fact[] }>('facts.yaml');
  const documents = loadYaml<Documents>('documents.yaml');
  return { entities, facts, documents };
}

/** Every expressedIn/factIds reference must resolve, or generation would silently
 *  corrupt the answer key (PLAN.md §6). Collect every error, don't stop at the first. */
function validate(entities: Entities, facts: Fact[], documents: Documents): string[] {
  const errors: string[] = [];
  const factIds = new Set(facts.map((f) => f.id));
  const allDocs: AnyDoc[] = [...documents.mail, ...documents.chat, ...documents.notes];
  const docIds = new Set(allDocs.map((d) => d.docId));

  for (const fact of facts) {
    for (const docId of fact.expressedIn) {
      if (!docIds.has(docId)) {
        errors.push(
          `facts.yaml: ${fact.id} expressedIn "${docId}" — no such document in documents.yaml`,
        );
      }
    }
    if (fact.supersedes && !factIds.has(fact.supersedes)) {
      errors.push(`facts.yaml: ${fact.id} supersedes "${fact.supersedes}" — no such fact`);
    }
  }

  for (const doc of allDocs) {
    for (const factId of doc.factIds) {
      if (!factIds.has(factId)) {
        errors.push(
          `documents.yaml: ${doc.docId} factIds references "${factId}" — no such fact in facts.yaml`,
        );
      }
    }
  }

  // Cross-check the other direction: every fact's expressedIn docs should actually
  // list that fact in their own factIds (keeps the two files honest with each other).
  const docById = new Map(allDocs.map((d) => [d.docId, d]));
  for (const fact of facts) {
    for (const docId of fact.expressedIn) {
      const doc = docById.get(docId);
      if (doc && !doc.factIds.includes(fact.id)) {
        errors.push(
          `facts.yaml: ${fact.id} lists expressedIn "${docId}", but documents.yaml's ${docId} ` +
            `does not list "${fact.id}" in its factIds — keep both directions in sync`,
        );
      }
    }
  }

  const ids = new Set(entities.people.map((p) => p.id));
  if (ids.size !== entities.people.length) errors.push('entities.yaml: duplicate person id');

  return errors;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function personName(entities: Entities, ref: string): string {
  const person = entities.people.find((p) => p.id === ref);
  return person ? person.name : ref;
}

function factContext(facts: Fact[], factIds: string[]): string {
  if (factIds.length === 0)
    return '(none — this document should not contain any of the tracked facts below; it is pure background noise.)';
  return factIds
    .map((id) => {
      const fact = facts.find((f) => f.id === id);
      if (!fact) throw new Error(`Unknown fact id ${id}`);
      return `- ${fact.statement.trim()}`;
    })
    .join('\n');
}

function buildPrompt(entities: Entities, facts: Fact[], source: SourceType, doc: AnyDoc): string {
  const header = `You are generating one synthetic internal document for a fictional ~30-person
software company, "${entities.company.name}", which builds "${entities.product.name}"
(${entities.product.description}). This is entirely fictional test data for a RAG system
demo — no real company, product, or person is involved.

Facts this document MUST convey precisely (exact dates, names, and numbers must appear
literally as given — do not round, rephrase numerically, or omit them):
${factContext(facts, doc.factIds)}

Rules:
- Do not invent any NEW dates, decisions, dollar amounts, or names that could be mistaken
  for a tracked fact. Background color (small talk, tangents, scheduling chatter) is fine
  and encouraged, but it must stay vague/generic, not specific and fact-shaped.
- Write ONLY the message/document body. Do NOT include a frontmatter block, subject line
  restatement, or any metadata — that is added separately by the generation script.
- Natural, realistic workplace tone. Not overly formal, not a template.`;

  if (source === 'mail') {
    const m = doc as MailDoc;
    return `${header}

Format: ONE email message body (no subject line, no headers — just the message body a
person would type). From ${m.from}, to ${m.to.join(', ')}, dated ${m.date}. Length: roughly
60-180 words.

What this specific message should contain:
${m.brief.trim()}`;
  }

  if (source === 'chat') {
    const c = doc as ChatDoc;
    const names = c.participants.map((p) => personName(entities, p));
    return `${header}

Format: a short Slack-style chat transcript in the #${c.channel} channel, dated ${c.date},
between ${names.join(' and ')}. 3-7 short messages, each on its own line as
"Name: message text". Keep individual messages short and casual, the way real chat
messages are (not email-length paragraphs).

What this conversation should be about:
${(doc as ChatDoc).brief.trim()}`;
  }

  const n = doc as NoteDoc;
  return `${header}

Format: an Obsidian-style internal note titled "${n.title}" (do not repeat the title as a
heading — that's added separately). Use short paragraphs and, where natural, [[wikilink]]
references to related topics (e.g. [[Helios]], [[Aurora migration]]) even if those exact
notes don't exist yet. Length: roughly 120-350 words.

What this note should cover:
${n.brief.trim()}`;
}

// ---------------------------------------------------------------------------
// Gemini call with retry/backoff
// ---------------------------------------------------------------------------

async function callGemini(prompt: string): Promise<string> {
  if (!GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY is not set. Add it to .env before running `pnpm corpus:generate` ' +
        '(this is a one-off authoring script, not something the running app needs).',
    );
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0 },
  };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error(`Gemini returned no text: ${JSON.stringify(data)}`);
      return text.trim();
    }

    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const delayMs = 1000 * 2 ** attempt;
      console.warn(
        `  [retry] Gemini ${res.status}, backing off ${delayMs}ms (attempt ${attempt}/${MAX_RETRIES})`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    throw new Error(`Gemini request failed: ${res.status} ${await res.text()}`);
  }

  throw new Error('unreachable');
}

/**
 * One generated body, rate-limited.
 *
 * The delay keeps the script under Gemini's free-tier requests-per-minute cap.
 * It sits here rather than in the main loop so that a verbatim document — which
 * makes no request at all — does not pay for a rate limit it is not subject to.
 */
async function generateBody(prompt: string): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 4500));
  return callGemini(prompt);
}

// ---------------------------------------------------------------------------
// Concurrency limiter (no new dependency — a small semaphore is enough here)
// ---------------------------------------------------------------------------

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  // `new Array<R>(n)` still widens to any[] under the typed-lint rules; a filled
  // array of the right length is equivalent here and keeps the type honest.
  const results: R[] = Array.from({ length: items.length });
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Frontmatter + file writing
// ---------------------------------------------------------------------------

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function buildFrontmatter(source: SourceType, doc: AnyDoc): string {
  const lines: string[] = ['---'];
  lines.push(`docId: ${yamlScalar(doc.docId)}`);
  lines.push(`source: ${source}`);

  if (source === 'mail') {
    const m = doc as MailDoc;
    lines.push(`threadId: ${yamlScalar(m.threadId)}`);
    lines.push(`subject: ${yamlScalar(m.subject)}`);
    lines.push(`from: ${yamlScalar(m.from)}`);
    lines.push(`to: [${m.to.map(yamlScalar).join(', ')}]`);
    lines.push(`date: ${m.date}`);
  } else if (source === 'chat') {
    const c = doc as ChatDoc;
    lines.push(`channel: ${yamlScalar(c.channel)}`);
    lines.push(`date: ${c.date}`);
    lines.push(`participants: [${c.participants.map(yamlScalar).join(', ')}]`);
  } else {
    const n = doc as NoteDoc;
    lines.push(`title: ${yamlScalar(n.title)}`);
    lines.push(`tags: [${n.tags.map(yamlScalar).join(', ')}]`);
    lines.push(`updated: ${n.updated}`);
  }

  lines.push('---');
  return lines.join('\n');
}

function heading(source: SourceType, doc: AnyDoc): string {
  if (source === 'mail') return `# ${(doc as MailDoc).subject}`;
  if (source === 'chat') return `# #${(doc as ChatDoc).channel} — ${(doc as ChatDoc).date}`;
  return `# ${(doc as NoteDoc).title}`;
}

function filePathFor(source: SourceType, doc: AnyDoc): string {
  // docId looks like "mail.thread-helios-date-change.msg-1" — strip the leading
  // "<source>." and use the remainder as the filename verbatim.
  const rest = doc.docId.slice(source.length + 1);
  return resolve(OUTPUT_DIR, source, `${rest}.md`);
}

// ---------------------------------------------------------------------------
// Deterministic verification (see header comment for rationale)
// ---------------------------------------------------------------------------

function extractCheckTokens(entities: Entities, factStatement: string): string[] {
  const tokens = new Set<string>();

  for (const m of factStatement.matchAll(/\d{4}-\d{2}-\d{2}/g)) tokens.add(m[0]);
  for (const m of factStatement.matchAll(/\$[\d,]+(?:\.\d+)?[MK]?/g)) tokens.add(m[0]);
  for (const m of factStatement.matchAll(/\b\d+x\b/g)) tokens.add(m[0]);

  const knownNames = [
    ...entities.people.map((p) => p.name),
    ...entities.customers.map((c) => c.name),
    ...entities.projects.map((p) => p.name),
    entities.company.name,
    entities.product.name,
  ];
  for (const name of knownNames) {
    if (factStatement.includes(name)) tokens.add(name);
  }

  return [...tokens];
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * The forms a token may legitimately take in natural prose. Only dates vary: a person
 * writing an email says "February 25, 2026", not "2026-02-25", and forcing ISO strings
 * into email bodies would make the corpus read like machine output — the exact weakness
 * synthetic corpora are criticised for. Names and amounts are required verbatim, since
 * there is no natural-language variation worth allowing there (a full name either appears
 * or it doesn't, and that distinction is what retrieval depends on).
 */
function acceptableRenderings(token: string): string[] {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(token);
  if (!iso) return [token];

  const [, year, month, day] = iso;
  const monthName = MONTHS[Number(month) - 1];
  const d = String(Number(day)); // un-padded, e.g. "5" for "05"

  return [
    token,
    `${monthName} ${d}, ${year}`,
    `${monthName} ${day}, ${year}`,
    `${d} ${monthName} ${year}`,
    `${day} ${monthName} ${year}`,
    `${monthName.slice(0, 3)} ${d}, ${year}`,
    `${monthName.slice(0, 3)} ${day}, ${year}`,
  ];
}

/**
 * `retrievableText` must be exactly what survives into the search index — the `# heading`
 * plus the generated body, but NOT the frontmatter. The app's markdown loader parses files
 * with gray-matter and chunks only `content`, so a fact that appears solely in a frontmatter
 * field (`date:`, `subject:`, `title:`) is invisible to retrieval and must still be reported
 * as missing. Verifying the raw model output alone is equally wrong in the other direction:
 * it flags facts that legitimately live in the generated heading.
 */
function verify(
  entities: Entities,
  facts: Fact[],
  doc: AnyDoc,
  retrievableText: string,
): GenerationReportEntry['verification'] {
  const haystack = retrievableText.toLowerCase();
  const checks: GenerationReportEntry['verification'] = [];

  for (const factId of doc.factIds) {
    const fact = facts.find((f) => f.id === factId);
    if (!fact) continue;
    for (const token of extractCheckTokens(entities, fact.statement)) {
      const found = acceptableRenderings(token).some((form) =>
        haystack.includes(form.toLowerCase()),
      );
      checks.push({ token, found });
    }
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verifyOnly = args.includes('--verify-only');
  const onlyArg = args.find((a) => a.startsWith('--only='))?.split('=')[1];

  const { entities, facts, documents } = loadLedger();

  const errors = validate(entities, facts, documents);
  if (errors.length > 0) {
    console.error(`Ledger validation failed with ${errors.length} error(s):\n`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('Ledger validation passed.\n');

  let allDocs: { source: SourceType; doc: AnyDoc }[] = [
    ...documents.mail.map((doc) => ({ source: 'mail' as const, doc })),
    ...documents.chat.map((doc) => ({ source: 'chat' as const, doc })),
    ...documents.notes.map((doc) => ({ source: 'notes' as const, doc })),
  ];

  if (onlyArg) {
    allDocs = allDocs.filter(
      ({ source, doc }) =>
        source === onlyArg || doc.docId.startsWith(onlyArg) || doc.factIds.includes(onlyArg),
    );
    console.log(`--only=${onlyArg} matched ${allDocs.length} document(s).\n`);
  }

  const report: GenerationReportEntry[] = [];
  let completed = 0;

  // --verify-only re-checks the corpus already on disk without calling the model.
  // This is what makes hand-editing a generated document safe (PLAN.md §12.2): edit
  // the prose, re-run this, and confirm the facts still survive — no API calls, no
  // risk of regenerating and losing the edit.
  if (verifyOnly) {
    console.log(`Verifying ${allDocs.length} document(s) already on disk (no model calls)...\n`);
    for (const { source, doc } of allDocs) {
      const path = filePathFor(source, doc);
      if (!existsSync(path)) {
        console.log(`  [missing] ${doc.docId} — no file at ${path}`);
        continue;
      }
      // Strip frontmatter the same way the app's markdown loader does, so we verify
      // exactly the text that reaches the index.
      const raw = readFileSync(path, 'utf-8');
      const retrievableText = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');

      const verification = verify(entities, facts, doc, retrievableText);
      const needsReview = verification.some((v) => !v.found);
      report.push({
        docId: doc.docId,
        source,
        path,
        factIds: doc.factIds,
        verification,
        needsReview,
      });
    }
    writeReport(report);
    return;
  }

  console.log(
    `Generating ${allDocs.length} document(s) (mail=${documents.mail.length}, ` +
      `chat=${documents.chat.length}, notes=${documents.notes.length})${dryRun ? ' [dry run]' : ''}...\n`,
  );

  await mapWithConcurrency(allDocs, CONCURRENCY, async ({ source, doc }) => {
    const prompt = buildPrompt(entities, facts, source, doc);
    const path = filePathFor(source, doc);

    if (dryRun) {
      const preview = doc.verbatim ? `[verbatim body]\n${doc.verbatim}` : prompt;
      console.log(`--- ${doc.docId} (${path}) ---\n${preview}\n`);
      return;
    }

    // A verbatim document costs no call and no quota, so it also skips the rate
    // limiter below — regenerating the adversarial set is free and instant.
    const body = doc.verbatim ? doc.verbatim.trim() : await generateBody(prompt);
    const retrievableText = `${heading(source, doc)}\n\n${body}\n`;
    const content = `${buildFrontmatter(source, doc)}\n\n${retrievableText}`;

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf-8');

    const verification = verify(entities, facts, doc, retrievableText);
    const needsReview = verification.some((v) => !v.found);
    report.push({
      docId: doc.docId,
      source,
      path: path
        .replace(resolve(__dirname, '..') + '\\', '')
        .replace(resolve(__dirname, '..') + '/', ''),
      factIds: doc.factIds,
      verification,
      needsReview,
    });

    completed++;
    const flag = needsReview ? ' [NEEDS REVIEW]' : '';
    console.log(`  [${completed}/${allDocs.length}] ${doc.docId}${flag}`);
  });

  if (dryRun) return;

  writeReport(report);
}

function writeReport(report: GenerationReportEntry[]): void {
  const repoRoot = resolve(__dirname, '..');
  const needingReview = report.filter((r) => r.needsReview);

  writeFileSync(
    REPORT_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        total: report.length,
        needingReview: needingReview.length,
        entries: report.map((r) => ({
          ...r,
          // Repo-relative with forward slashes, so the report reads the same on
          // Windows and Linux (it is regenerable, but should not churn by platform).
          path: r.path
            .replace(repoRoot + '\\', '')
            .replace(repoRoot + '/', '')
            .replace(/\\/g, '/'),
        })),
      },
      null,
      2,
    ),
  );

  console.log(`\nDone. ${report.length} document(s) checked.`);
  if (needingReview.length > 0) {
    console.log(
      `\n${needingReview.length} document(s) failed a verification check — a tracked fact's exact`,
    );
    console.log(
      `date/name/amount did not appear in the retrievable text. Review before committing:\n`,
    );
    for (const r of needingReview) {
      const missing = r.verification.filter((v) => !v.found).map((v) => v.token);
      console.log(`  - ${r.docId}: missing [${missing.join(', ')}]`);
    }
    console.log(`\nFull report: ${REPORT_PATH}`);
  } else {
    console.log('All fact-bearing documents passed verification.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
