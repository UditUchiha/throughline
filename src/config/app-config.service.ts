import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig, McpServerConfig } from './env.schema';

export type LlmProvider = 'gemini' | 'groq' | 'openrouter' | 'ollama';
export type EmbeddingProviderType = 'gemini' | 'ollama' | 'precomputed';

@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService<EnvConfig, true>) {}

  get port(): number {
    return this.configService.get('PORT', { infer: true });
  }

  // --- LLM ---

  get llmProvider(): LlmProvider {
    return this.configService.get('LLM_PROVIDER', { infer: true });
  }

  get llmApiKey(): string | undefined {
    return this.configService.get('LLM_API_KEY', { infer: true });
  }

  get llmModelFast(): string | undefined {
    return this.configService.get('LLM_MODEL_FAST', { infer: true });
  }

  get llmModelDefault(): string | undefined {
    return this.configService.get('LLM_MODEL_DEFAULT', { infer: true });
  }

  get llmModelDeep(): string | undefined {
    return this.configService.get('LLM_MODEL_DEEP', { infer: true });
  }

  get llmMaxRetries(): number {
    return this.configService.get('LLM_MAX_RETRIES', { infer: true });
  }

  get llmFallbackProviders(): LlmProvider[] {
    return this.configService.get('LLM_FALLBACK_PROVIDERS', { infer: true });
  }

  /**
   * Every key configured for one provider, in the order they should be tried.
   *
   * A provider's key variable may hold **several comma-separated keys** — the
   * same idiom `LLM_FALLBACK_PROVIDERS` already uses. This exists because a free
   * tier's quota is per *credential*, not per vendor: a second Gemini key is
   * strictly better headroom than falling through to a different vendor, whose
   * model answers differently. §11 measured exactly that — Groq returning 2
   * citations where Gemini returned 5 on the same multi-hop question — so a
   * chain that reaches Groq early does not just get slower, it measures
   * something else.
   *
   * Each provider prefers its own `<PROVIDER>_API_KEY`. `LLM_API_KEY` is only
   * accepted for the *primary* provider — it is that provider's key, and handing
   * it to a fallback hop would authenticate to the wrong service with a
   * confusing 401. Returns an empty array when nothing is configured, which is
   * how the chain builder knows to skip a provider rather than fail the boot.
   */
  llmApiKeysFor(provider: LlmProvider): string[] {
    // Ollama is local and unauthenticated; the SDK still wants a non-empty string.
    if (provider === 'ollama') return ['ollama'];

    const own =
      provider === 'gemini'
        ? this.configService.get('GEMINI_API_KEY', { infer: true })
        : provider === 'groq'
          ? this.configService.get('GROQ_API_KEY', { infer: true })
          : this.configService.get('OPENROUTER_API_KEY', { infer: true });

    const raw = own || (provider === this.llmProvider ? this.llmApiKey : undefined);
    return splitKeys(raw);
  }

  /**
   * The first key for one provider — what callers that can only hold one want.
   *
   * Kept as the single-key accessor rather than removed, because the embedding
   * provider authenticates one client and has no chain to fall through.
   */
  llmApiKeyFor(provider: LlmProvider): string | undefined {
    return this.llmApiKeysFor(provider)[0];
  }

  // --- Embedding ---

  get embeddingProvider(): EmbeddingProviderType {
    return this.configService.get('EMBEDDING_PROVIDER', { infer: true });
  }

  /**
   * The embedding key — first only, because one client authenticates once.
   *
   * Split like the LLM keys so a comma-separated value set here does not
   * authenticate with the literal string "key-a,key-b". Embeddings have no
   * failover chain to spend the rest on; surviving a quota wall here is
   * `EMBEDDING_PROVIDER=precomputed` at build time, not a second credential.
   */
  get embeddingApiKey(): string | undefined {
    return splitKeys(this.configService.get('EMBEDDING_API_KEY', { infer: true }))[0];
  }

  get embeddingModel(): string {
    return this.configService.get('EMBEDDING_MODEL', { infer: true });
  }

  get embeddingDimensions(): number {
    return this.configService.get('EMBEDDING_DIMENSIONS', { infer: true });
  }

  get embeddingVectorsPath(): string {
    return this.configService.get('EMBEDDING_VECTORS_PATH', { infer: true });
  }

  // --- Ollama ---

  get ollamaUrl(): string {
    return this.configService.get('OLLAMA_URL', { infer: true });
  }

  get chatModel(): string {
    return this.configService.get('CHAT_MODEL', { infer: true });
  }

  // --- Paths ---

  get databasePath(): string {
    return this.configService.get('DATABASE_PATH', { infer: true });
  }

  get knowledgePath(): string {
    return this.configService.get('KNOWLEDGE_PATH', { infer: true });
  }

  get demoRunsPath(): string {
    return this.configService.get('DEMO_RUNS_PATH', { infer: true });
  }

  get corpusQuestionsPath(): string {
    return this.configService.get('CORPUS_QUESTIONS_PATH', { infer: true });
  }

  // --- Indexing ---

  get reindexIntervalMs(): number {
    return this.configService.get('REINDEX_INTERVAL_MS', { infer: true });
  }

  // --- Retrieval ---

  get topK(): number {
    return this.configService.get('TOP_K', { infer: true });
  }

  get chunkSize(): number {
    return this.configService.get('CHUNK_SIZE', { infer: true });
  }

  get chunkOverlap(): number {
    return this.configService.get('CHUNK_OVERLAP', { infer: true });
  }

  get retrievalDistanceThreshold(): number {
    return this.configService.get('RETRIEVAL_DISTANCE_THRESHOLD', { infer: true });
  }

  // --- Agent ---

  get maxHops(): number {
    return this.configService.get('MAX_HOPS', { infer: true });
  }

  get maxFanOut(): number {
    return this.configService.get('MAX_FAN_OUT', { infer: true });
  }

  get agentTimeoutMs(): number {
    return this.configService.get('AGENT_TIMEOUT_MS', { infer: true });
  }

  // --- Connectors (PLAN.md §5/M5) ---

  /**
   * Serve connectors from bundled synthetic data rather than anything real.
   *
   * Not the same thing as `?demo=1`, which replays a recorded run and makes no
   * model calls: this runs the whole live pipeline and only changes where a
   * connector's documents come from. See DEMO_MODE in env.schema.ts.
   */
  get demoMode(): boolean {
    return this.configService.get('DEMO_MODE', { infer: true });
  }

  get mcpServers(): McpServerConfig[] {
    return this.configService.get('MCP_SERVERS', { infer: true });
  }

  get mcpDemoVaultPath(): string {
    return this.configService.get('MCP_DEMO_VAULT_PATH', { infer: true });
  }

  get mcpTimeoutMs(): number {
    return this.configService.get('MCP_TIMEOUT_MS', { infer: true });
  }

  // --- Memory ---

  get checkpointRetentionSessions(): number {
    return this.configService.get('CHECKPOINT_RETENTION_SESSIONS', { infer: true });
  }

  get memoryImportanceFloor(): number {
    return this.configService.get('MEMORY_IMPORTANCE_FLOOR', { infer: true });
  }

  get memoryDedupDistance(): number {
    return this.configService.get('MEMORY_DEDUP_DISTANCE', { infer: true });
  }

  get longTermMemory(): boolean {
    return this.configService.get('LONG_TERM_MEMORY', { infer: true });
  }

  get memoryTopK(): number {
    return this.configService.get('MEMORY_TOP_K', { infer: true });
  }

  get memoryRecallDistance(): number {
    return this.configService.get('MEMORY_RECALL_DISTANCE', { infer: true });
  }

  get memoryTtlDays(): number {
    return this.configService.get('MEMORY_TTL_DAYS', { infer: true });
  }

  get memoryConsolidationIntervalMs(): number {
    return this.configService.get('MEMORY_CONSOLIDATION_INTERVAL_MS', { infer: true });
  }

  // --- Public surface (PLAN.md §9) ---

  get rateLimitEnabled(): boolean {
    return this.configService.get('RATE_LIMIT_ENABLED', { infer: true });
  }

  get rateLimitWindowMs(): number {
    return this.configService.get('RATE_LIMIT_WINDOW_MS', { infer: true });
  }

  get rateLimitMaxAsks(): number {
    return this.configService.get('RATE_LIMIT_MAX_ASKS', { infer: true });
  }

  get trustProxyHops(): number {
    return this.configService.get('TRUST_PROXY_HOPS', { infer: true });
  }

  get quotaFallbackCooldownMs(): number {
    return this.configService.get('QUOTA_FALLBACK_COOLDOWN_MS', { infer: true });
  }

  // --- Observability ---

  get traceRetentionRuns(): number {
    return this.configService.get('TRACE_RETENTION_RUNS', { infer: true });
  }

  get langsmithTracing(): boolean {
    return this.configService.get('LANGSMITH_TRACING', { infer: true });
  }

  get langsmithApiKey(): string | undefined {
    return this.configService.get('LANGSMITH_API_KEY', { infer: true });
  }

  get langsmithProject(): string {
    return this.configService.get('LANGSMITH_PROJECT', { infer: true });
  }

  get langsmithEndpoint(): string {
    return this.configService.get('LANGSMITH_ENDPOINT', { infer: true });
  }
}

/**
 * Splits a key variable that may carry more than one credential.
 *
 * Tolerant of trailing separators and stray whitespace because these arrive by
 * being pasted into a dashboard field, not typed into a file. API keys do not
 * contain commas, so this cannot split one in half.
 */
function splitKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}
