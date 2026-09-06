import { z } from 'zod';

/**
 * Default location of the sqlite database.
 *
 * Exported because one thing outside the application needs it: the eval harness
 * has to know which database it is copying *from* before Nest exists to tell it,
 * and it had this string written out a second time. A default duplicated across
 * a boundary desynchronises silently — the harness would go on isolating a file
 * nobody uses, and index the corpus from scratch to do it.
 */
export const DEFAULT_DATABASE_PATH = './database/app.db';

const llmProviderEnum = z.enum(['gemini', 'groq', 'openrouter', 'ollama']).default('gemini');
// `precomputed` is a **build-time** provider, not a runtime one: it replays vectors
// from a committed artifact instead of calling anything, which is what makes the
// Docker index build keyless and offline (PLAN.md §9). It can only answer for text
// it has a vector for — the fixed corpus — so a server started with it fails on the
// first query embedding, loudly and by design. See PrecomputedEmbeddingProvider.
const embeddingProviderEnum = z.enum(['gemini', 'ollama', 'precomputed']).default('gemini');
// Mirrors CorpusSource in src/common/types/knowledge.types.ts. Declared again rather
// than imported so the env schema stays free of domain imports — it is parsed before
// anything else exists, and a cycle here fails the boot in a very confusing way.
const corpusSourceEnum = z.enum(['mail', 'chat', 'notes']);

// `z.coerce.boolean()` is not usable for env flags: it follows JS truthiness, so the
// string "false" coerces to `true`. Enumerating the accepted spellings instead means a
// typo fails at boot with a readable message rather than silently enabling something.
//
// A factory rather than a single schema because not every flag defaults off — see
// DEMO_MODE — and stacking a second `.default()` onto a finished pipeline is the kind
// of Zod subtlety that reads as a bug six months later.
const envBoolean = (fallback: 'true' | 'false' = 'false') =>
  z
    .string()
    .default(fallback)
    .transform((raw) => raw.trim().toLowerCase())
    .pipe(z.enum(['true', 'false', '1', '0']))
    .transform((value) => value === 'true' || value === '1');

/**
 * One MCP server the host connects to, as it appears in `MCP_SERVERS`.
 *
 * A server is launched, not dialled: `command` + `args` is a child process
 * speaking MCP over stdio, which is how every local connector (Obsidian,
 * filesystem) ships. That means the value of this variable is a command line the
 * API will execute — treat it with the same care as any other, and note that it
 * is read once at boot and never from anything a model produced.
 */
const mcpServerSchema = z.object({
  /**
   * Registry prefix for this server's tools, and the `evidenceId` namespace for
   * everything it returns. Constrained to the shape a tool name can take, because
   * it becomes one: `obsidian` yields `obsidian_search_notes`.
   */
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'MCP server name must be lower_snake_case'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** Extra environment for the child process — an API token, a vault path. */
  env: z.record(z.string(), z.string()).default({}),
  /**
   * Which corpus source this server's content is filed under, so its evidence
   * renders alongside the corpus rather than as an unstyled fourth category. A
   * vault is `notes`, Gmail is `mail`, Slack is `chat` — the three the UI
   * already has a colour for (PLAN.md §5/M5 targets them in exactly that order).
   */
  source: corpusSourceEnum,
  /**
   * The tools on that server the agent may call. **Required, and an allowlist
   * rather than a denylist**: an MCP server advertises whatever it likes,
   * including writes and deletes, and discovery is not consent. A server whose
   * allowlist names nothing it exposes registers no tools and says so at boot.
   */
  allowTools: z.array(z.string().min(1)).min(1),
  /**
   * The parameter the search query goes in, when the server does not call it
   * `query`. Left unset, the host infers it from the tool's own input schema —
   * see `resolveQueryArg`.
   */
  queryArg: z.string().min(1).optional(),
});

export type McpServerConfig = z.output<typeof mcpServerSchema>;

export const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(5000),

    // --- LLM provider (chat completions) ---
    LLM_PROVIDER: llmProviderEnum,
    LLM_API_KEY: z.string().optional(),

    // Ordered fallback chain, tried left to right when the primary provider is out
    // of quota or unreachable. PLAN.md §9 asks for exactly this: "catch quota errors,
    // fall back to the next configured provider". Empty means no failover.
    LLM_FALLBACK_PROVIDERS: z
      .string()
      .default('')
      .transform((raw) =>
        raw
          .split(',')
          .map((name) => name.trim().toLowerCase())
          .filter(Boolean),
      )
      .pipe(z.array(llmProviderEnum.removeDefault())),

    // Per-provider keys, so a fallback chain can authenticate to each hop. The
    // provider actually in use falls back to LLM_API_KEY when its own key is absent,
    // which keeps a single-provider setup a one-variable affair.
    GEMINI_API_KEY: z.string().optional(),
    GROQ_API_KEY: z.string().optional(),
    OPENROUTER_API_KEY: z.string().optional(),
    LLM_MODEL_FAST: z.string().optional(),
    LLM_MODEL_DEFAULT: z.string().optional(),
    LLM_MODEL_DEEP: z.string().optional(),
    // Deliberately low. Retries help a transient 5xx or a dropped connection; they are
    // actively harmful against a *quota* 429, because every attempt counts against the
    // same small budget — measured on Gemini's free tier (limit 20), maxRetries=5 turned
    // one synthesis call into six and exhausted the window faster than not retrying.
    // Surviving a quota limit needs a fallback provider (PLAN.md §9), not persistence.
    LLM_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),

    // --- Embedding provider ---
    EMBEDDING_PROVIDER: embeddingProviderEnum,
    EMBEDDING_API_KEY: z.string().optional(),
    // Defaulted to match EMBEDDING_PROVIDER's own default, which they did not.
    // `bge-m3` at 1024d is an *Ollama* model, left behind when Ollama was the
    // default provider; paired with the current default of `gemini` it produces a
    // configuration that cannot work, and one that nothing local ever hit because
    // `.env` supplies both. The Docker image has no `.env`, so §9 found it on the
    // first container boot: the index identity guard refused to start against
    // `gemini/bge-m3:1024`. An Ollama setup sets both explicitly — `.env.example`
    // shows the pair — which is the right way round, because the provider that
    // needs a key is the one whose defaults should be usable without one.
    EMBEDDING_MODEL: z.string().min(1).default('gemini-embedding-001'),
    EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(768),

    /**
     * The committed vectors `EMBEDDING_PROVIDER=precomputed` replays, written by
     * `pnpm corpus:vectors`.
     *
     * The artifact carries its own model id and dimension count, and the
     * provider reports *those* rather than the two variables above — so the
     * `index_meta` identity written by a keyless build is the identity of the
     * model that actually produced the numbers, not of whatever the build
     * environment happened to have configured.
     */
    EMBEDDING_VECTORS_PATH: z.string().min(1).default('./corpus/index/embeddings.json'),

    // --- Ollama (used when LLM_PROVIDER=ollama or EMBEDDING_PROVIDER=ollama) ---
    OLLAMA_URL: z.url().default('http://localhost:11434'),
    CHAT_MODEL: z.string().min(1).default('qwen3.5:9b'),

    // --- Paths ---
    DATABASE_PATH: z.string().min(1).default(DEFAULT_DATABASE_PATH),
    KNOWLEDGE_PATH: z.string().min(1).default('./corpus/generated'),
    // Recorded agent runs, replayed over SSE for the §9 demo fallback and for
    // building the UI without spending model calls. Written by `pnpm capture:runs`.
    DEMO_RUNS_PATH: z.string().min(1).default('./fixtures/runs'),
    // The authored question set (PLAN.md §6). Served to the UI as one-click examples,
    // which §5/M2 calls non-optional: a visitor has no idea what this corpus contains.
    // Only the question and its category are ever served — see ExampleQuestionsService.
    CORPUS_QUESTIONS_PATH: z.string().min(1).default('./corpus/questions.yaml'),

    // --- Indexing ---
    REINDEX_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(30 * 60 * 1000),

    // --- Retrieval ---
    TOP_K: z.coerce.number().int().positive().default(5),
    // Measured in words, not characters — see the comment on chunkText().
    CHUNK_SIZE: z.coerce.number().int().positive().default(700),
    CHUNK_OVERLAP: z.coerce.number().int().nonnegative().default(150),

    // NOT CURRENTLY ENFORCED. `RetrievalService.search` returns top-K regardless of
    // distance; nothing reads this value.
    //
    // Left in place rather than deleted because the methodology to make it real is
    // already written up in docs/retrieval-threshold-study.md — but that study derived
    // 0.902 for `bge-m3` at 1024 dimensions, and the default provider is now
    // `gemini-embedding-001` at 768. The study's own conclusion is that a distance
    // threshold is *not portable across embedding models*, and it documents a previous
    // outage caused by exactly that. So enforcing this number today would reproduce the
    // bug the study exists to prevent. Re-derive it against the current model in M6,
    // where the eval harness can measure the trade-off, then wire it up.
    RETRIEVAL_DISTANCE_THRESHOLD: z.coerce.number().nonnegative().default(0.9),

    // --- Agent ---
    MAX_HOPS: z.coerce.number().int().nonnegative().default(2),
    MAX_FAN_OUT: z.coerce.number().int().positive().default(5),

    // Total wall-clock budget for one agent run. The graph aborts in-flight model
    // calls and drains rather than letting a slow provider hang an SSE stream open.
    AGENT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60 * 1000),

    // --- Connectors (PLAN.md §5/M5) ---

    /**
     * Serve the connectors from bundled synthetic data instead of connecting to
     * anything real.
     *
     * Defaults to **on**, which is the unusual choice and the deliberate one:
     * §9's deployed instance runs this way, and so does every fresh clone, so the
     * default that makes `git clone && pnpm start` demonstrate the connector is
     * the one that should need no configuration. Live connectors are the
     * local-only capability (§5/M5), not the other way round.
     *
     * This is **not** `?demo=1`. That query parameter replays a recorded run from
     * `fixtures/runs/` and makes no model calls at all. DEMO_MODE runs the entire
     * live pipeline — triage, planning, retrieval, synthesis, memory — and only
     * swaps *where a connector's documents come from*. Conflating the two is how
     * the deployed demo ends up replaying fixtures and never exercising anything.
     *
     * It removes the need for *connector* credentials — a Gmail OAuth grant, a
     * Slack token, a vault on disk. It does not remove the need for an LLM key;
     * nothing can answer a question without one.
     */
    DEMO_MODE: envBoolean('true'),

    /**
     * MCP servers to connect to at boot, as a JSON array. Ignored (with a warning)
     * while DEMO_MODE is on.
     *
     * Discovery happens once, at boot, and the tool registry is built from the
     * result — a server that is down when the API starts is logged and skipped for
     * the lifetime of the process rather than appearing later. That is a
     * deliberate limit: the registry is immutable by construction, which is what
     * lets the planner read a stable tool menu, and a hot-reloading registry is an
     * abstraction with exactly one caller (PLAN.md §0.4).
     */
    MCP_SERVERS: z
      .string()
      .default('[]')
      .transform((raw, ctx) => {
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          ctx.addIssue({ code: 'custom', message: 'MCP_SERVERS must be valid JSON' });
          return z.NEVER;
        }
      })
      .pipe(z.array(mcpServerSchema)),

    /**
     * The synthetic vault DEMO_MODE's Obsidian connector serves. Committed, so a
     * clone has one; small on purpose, since it is searched lexically rather than
     * by embedding and is meant to be read by a visitor in a few seconds.
     */
    MCP_DEMO_VAULT_PATH: z.string().min(1).default('./fixtures/mcp/vault'),

    /**
     * Budget for connecting to an MCP server, listing its tools, and each search
     * call afterwards.
     *
     * Generous because the first connection is the slow one: a stdio server
     * launched through `npx` may download the package before it says anything,
     * and a boot that gives up after two seconds looks exactly like a broken
     * server. A search is additionally bounded by the run's own deadline, which
     * travels with the call as an AbortSignal.
     */
    MCP_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 1000),

    // --- Memory (PLAN.md §5/M4.1) ---

    /**
     * Whether durable, cross-session memory runs at all (PLAN.md §5/M4.2).
     *
     * **Off on the public deployment, on everywhere else**, which is a §9
     * decision rather than a tuning knob. `recall()` searches all of
     * `memory_facts` with no visitor filter — crossing sessions *is* the M4.2
     * feature, so a session filter would delete what the milestone
     * demonstrates — and on a deployment with no sign-in, cross-session is also
     * cross-visitor: a fact extracted from one person's run reaches the next
     * person's planner prompt.
     *
     * What that actually exposes is narrow, because M6's `mentionsSelf` gate
     * means a corpus question stores nothing at all. The one reachable case is
     * a visitor writing a first-person sentence — which is exactly the case
     * that would leak. So the flag costs almost nothing visible and closes the
     * channel completely, and long-term memory becomes a local capability like
     * live connectors rather than a deployed one.
     *
     * Off also settles an inconsistency: `MemoryController` refuses to serve
     * fact bodies over HTTP while `memory_read` streams the nearest three to
     * whoever asks the next question. With nothing stored, the two agree.
     *
     * Short-term memory (M4.1, the checkpointer) is unaffected — it is keyed by
     * `sessionId` and never crossed a visitor boundary.
     */
    LONG_TERM_MEMORY: envBoolean('true'),

    // How many sessions the LangGraph checkpointer keeps. Oldest are pruned after
    // each run, on the same reasoning as TRACE_RETENTION_RUNS below and for a
    // sharper reason: a checkpoint is written on *every superstep*, carrying the
    // whole state including retrieved evidence, so one turn leaves ~7 snapshots
    // rather than one row. Measured on a real three-turn session: 22 checkpoint
    // rows, 93 pending-write rows, 231KB — roughly 77KB per turn, which is
    // several times what the same conversation costs the trace store. Unbounded,
    // the store that lets the agent remember a conversation becomes a log of
    // every intermediate state it has ever been in, and §9 ships
    // `database/app.db` inside the image.
    CHECKPOINT_RETENTION_SESSIONS: z.coerce.number().int().positive().default(50),

    // Minimum importance (0..1, assigned at extraction) for a candidate fact to be
    // considered at all. The floor is the cheapest stage of the funnel — it costs no
    // embedding call — so it is deliberately the first gate, and it is what keeps
    // "the system stores roughly N% of what it could" a real number rather than a
    // description of an append-only log.
    MEMORY_IMPORTANCE_FLOOR: z.coerce.number().min(0).max(1).default(0.5),

    // Vector distance at or below which a candidate is treated as *the same fact*
    // already stored, and merged into it instead of inserted.
    //
    // **L2, and specific to the current embedding model** — the same portability
    // trap `RETRIEVAL_DISTANCE_THRESHOLD` above documents at length. Derived from
    // measurement rather than feel, against `gemini-embedding-001` at 768d
    // (docs/memory-dedup-threshold.md): restatements of one fact land at
    // 0.087–0.276, related-but-distinct facts at 0.405–0.463, unrelated at
    // 0.51–0.59. 0.35 sits in the empty band between the first two groups with
    // margin on both sides. Re-derive it if the embedding model changes; too high
    // silently merges two different preferences into one, which is worse than a
    // duplicate.
    MEMORY_DEDUP_DISTANCE: z.coerce.number().positive().default(0.35),

    // How many remembered facts are injected into a run's context. Small on
    // purpose: memory competes with retrieved evidence for a free-tier context
    // window, and an irrelevant "fact" in the planner's prompt actively misdirects
    // retrieval.
    MEMORY_TOP_K: z.coerce.number().int().positive().default(3),

    // Ceiling on how far a stored fact may sit from the question and still be
    // recalled into a run. Above it, the fact is not about what is being asked.
    //
    // Without one, `recall` took the k nearest *regardless of distance*, so a
    // store smaller than MEMORY_TOP_K returned everything to every question —
    // exactly the "an irrelevant fact actively misdirects retrieval" failure
    // MEMORY_TOP_K's own comment describes. It also killed decay: `markUsed`
    // stamps whatever is returned, so every run refreshed every fact and
    // MEMORY_TTL_DAYS could never find a candidate to forget.
    //
    // **L2, and specific to the embedding model** — the same portability trap as
    // MEMORY_DEDUP_DISTANCE and RETRIEVAL_DISTANCE_THRESHOLD. Derived from the
    // same nine labelled pairs (docs/memory-dedup-threshold.md), which put
    // related-but-distinct facts at 0.405–0.463 and unrelated text at
    // 0.513–0.588. 0.49 takes the empty band between them, admitting a fact that
    // is merely *adjacent* to the question — "works on Helios" is worth recalling
    // for a Helios question — while excluding one that is about something else.
    //
    // ⚠️ **Weaker evidence than MEMORY_DEDUP_DISTANCE.** That band is 0.13 wide
    // with five points below it; this one is 0.05 wide with two points on each
    // side. It is the best available number rather than a well-supported one, and
    // unlike RETRIEVAL_DISTANCE_THRESHOLD it was at least measured against the
    // model actually in use. Re-derive it in M6 alongside the retention rate.
    MEMORY_RECALL_DISTANCE: z.coerce.number().positive().default(0.49),

    // A fact no question has touched in this many days is forgotten by the
    // consolidation job. Measured from `last_used_at` (when it was last retrieved
    // into a run) rather than `updated_at`, because "nothing anyone asks needs
    // this" is the signal worth acting on.
    MEMORY_TTL_DAYS: z.coerce.number().int().positive().default(30),

    // How often consolidation runs: merge near-duplicates that accumulated between
    // extractions, then forget what aged out. Rare on purpose — it is maintenance,
    // and it costs one embedding call per surviving fact.
    MEMORY_CONSOLIDATION_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(6 * 60 * 60 * 1000),

    // --- Public surface (PLAN.md §9) ---

    /**
     * Rate limiting on `POST /agent/ask`.
     *
     * The endpoint is unauthenticated and CORS is deliberately open (see the
     * comment in `main.ts`), so this is the only control standing between a
     * public URL and the day's free-tier budget. `DEMO_MODE` keeps the deployed
     * instance corpus-only, but that is a default protecting an open endpoint,
     * not a control.
     *
     * The budget is denominated in *model calls*, not requests: one question
     * costs ~4 of them against a free tier that answers ~20 per window, so the
     * default of 5 questions per 10 minutes is roughly one visitor's share of
     * the quota. `?demo=1` replays cost nothing and are exempt.
     *
     * An off switch rather than "set the number very high", because a limit
     * expressed as a large number reads like a limit and is not one.
     */
    RATE_LIMIT_ENABLED: envBoolean('true'),
    RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(10 * 60 * 1000),
    RATE_LIMIT_MAX_ASKS: z.coerce.number().int().positive().default(5),

    /**
     * How many reverse-proxy hops sit in front of the API, as Express's
     * `trust proxy` setting.
     *
     * This is load-bearing for the rate limit rather than cosmetic. Behind a
     * platform proxy every request arrives from the proxy's address, so at 0
     * the whole internet shares one bucket and the first visitor to spend their
     * five questions locks out everyone else. Trusting *too much* is the
     * opposite failure: `X-Forwarded-For` is client-supplied, so a hop count
     * larger than the real chain lets a caller mint a fresh identity per request
     * and the limit evaporates.
     *
     * 1 is right for a single platform proxy (Render, Northflank, Cloud Run, HF
     * Spaces). Set 0 when the API is reached directly.
     */
    TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().default(1),

    /**
     * How long the recorded-run fallback stays armed after every configured
     * provider has refused on quota (PLAN.md §9's "rate-limit resilience").
     *
     * A window rather than a probe because there is nothing free to probe with:
     * finding out whether the quota came back costs a model call, which is the
     * thing there is no budget for. So the run that hits the wall reports its
     * failure honestly and arms the fallback; requests inside the window replay
     * a recording instead, and the window simply expires.
     */
    QUOTA_FALLBACK_COOLDOWN_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(10 * 60 * 1000),

    // --- Observability (PLAN.md §5/M3) ---

    // LangGraph and the LangSmith OpenAI wrapper both read these from `process.env`
    // themselves, so `LangSmithTracing` copies them back out of here at boot. They are
    // declared in this schema anyway — that is what keeps §0.3's "no process.env outside
    // src/config" true rather than nominally true, and it means a malformed value fails
    // at boot instead of silently disabling tracing.
    // How many finished runs the local trace store keeps. Oldest are pruned on
    // write. There is deliberately no "unlimited": the in-memory store this
    // replaced was capped at 100 and emptied on restart, so making it durable
    // without a bound would have quietly turned a bounded buffer into a log that
    // grows forever — and §9 bakes `database/app.db` into the deployed image, so
    // whatever accumulated during development would ship with it. A run costs
    // roughly 25–50KB here, almost all of it the evidence text carried on
    // `evidence_added`, so 200 is a handful of megabytes at worst.
    TRACE_RETENTION_RUNS: z.coerce.number().int().positive().default(200),

    LANGSMITH_TRACING: envBoolean(),
    LANGSMITH_API_KEY: z.string().optional(),
    LANGSMITH_PROJECT: z.string().min(1).default('throughline'),
    LANGSMITH_ENDPOINT: z.url().default('https://api.smith.langchain.com'),
  })
  .refine((env) => env.CHUNK_OVERLAP < env.CHUNK_SIZE, {
    message: 'CHUNK_OVERLAP must be smaller than CHUNK_SIZE',
  })
  // Tracing without a key is the failure mode worth catching at boot: LangSmith's
  // client drops traces silently when it cannot authenticate, so the symptom is an
  // empty project half an hour later rather than an error at the call site.
  .refine((env) => !env.LANGSMITH_TRACING || Boolean(env.LANGSMITH_API_KEY), {
    message: 'LANGSMITH_TRACING is enabled but LANGSMITH_API_KEY is not set',
    path: ['LANGSMITH_API_KEY'],
  });

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${result.error.message}`);
  }
  return result.data;
}
