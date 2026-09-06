import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import type { EmbeddingProvider } from './embedding.types';

/**
 * The committed artifact, as written by `pnpm corpus:vectors`.
 *
 * `modelId` and `dimensions` travel *inside* it rather than being read from the
 * environment, because they describe the numbers rather than the process
 * replaying them: this is the identity that ends up in `index_meta` and that the
 * running server's real provider is checked against at boot.
 */
export interface PrecomputedVectorFile {
  modelId: string;
  dimensions: number;
  /** When the vectors were embedded — informational, printed on load. */
  generatedAt: string;
  /** sha256 of the exact chunk text → little-endian float32 vector, base64. */
  vectors: Record<string, string>;
}

/** The key a vector is filed under: the exact text, hashed. */
export function vectorKey(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function encodeVector(values: number[]): string {
  return Buffer.from(Float32Array.from(values).buffer).toString('base64');
}

export function decodeVector(encoded: string): number[] {
  const bytes = Buffer.from(encoded, 'base64');
  // `Buffer.from(base64)` may hand back a view into a pooled ArrayBuffer, so the
  // byteOffset is not necessarily 0. Reading the pool from 0 returns another
  // allocation's bytes — silently, as plausible-looking floats.
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  return Array.from(floats);
}

/**
 * Replays embeddings from a committed file instead of calling a provider.
 *
 * **This exists for one job: building the index at Docker build time without a
 * key or a network** (PLAN.md §9). §11.4 originally kept that property by
 * locking embeddings to a local in-process model; that decision was superseded
 * and the local provider was never written, which left §9's build needing a
 * secret and ~172 calls against a free tier that answers ~20 per window. Shipping
 * the *vectors* restores the property without restoring the dependency: they are
 * the only part of the index that cannot be recomputed offline, and everything
 * else in it already lives in git.
 *
 * It is deliberately not usable as a runtime provider. A running server embeds
 * *questions*, which are not in the artifact and cannot be — so the first search
 * throws, naming what happened. A provider that quietly returned a zero vector
 * instead would answer every question with the same five chunks and look like a
 * retrieval-quality problem for as long as it took someone to check.
 *
 * The lookup is keyed by a hash of the exact chunk text, which makes staleness
 * loud: change `CHUNK_SIZE`, edit a corpus document, or regenerate the corpus,
 * and the build fails on the first chunk that has no vector rather than
 * producing an index that is quietly a mixture of two corpora.
 */
@Injectable()
export class PrecomputedEmbeddingProvider implements EmbeddingProvider {
  private readonly logger = new Logger(PrecomputedEmbeddingProvider.name);
  private readonly path: string;
  private readonly vectors: Map<string, number[]>;
  readonly dimensions: number;
  readonly modelId: string;

  constructor(config: AppConfigService) {
    this.path = resolve(config.embeddingVectorsPath);

    if (!existsSync(this.path)) {
      throw new Error(
        `EMBEDDING_PROVIDER=precomputed needs the vector artifact at "${this.path}", ` +
          `which does not exist. Generate it with \`pnpm corpus:vectors\` (needs an ` +
          `embedding key, ~172 calls) and commit it.`,
      );
    }

    const file = parseVectorFile(readFileSync(this.path, 'utf8'), this.path);
    this.modelId = file.modelId;
    this.dimensions = file.dimensions;
    this.vectors = new Map(
      Object.entries(file.vectors).map(([key, encoded]) => [key, decodeVector(encoded)]),
    );

    this.logger.log(
      `Embedding provider: precomputed (${this.modelId}, ${this.dimensions}d, ` +
        `${this.vectors.size} vectors, generated ${file.generatedAt})`,
    );
  }

  /** How many texts this artifact can answer for — the build's expected chunk count. */
  get size(): number {
    return this.vectors.size;
  }

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => this.lookup(text)));
  }

  private lookup(text: string): number[] {
    const found = this.vectors.get(vectorKey(text));
    if (found) return found;

    // Truncated because a chunk is up to ~4000 characters and the useful part of
    // the message is which text missed, not the whole document.
    const preview = text.slice(0, 120).replace(/\s+/g, ' ');
    throw new Error(
      `No precomputed vector for "${preview}…". The artifact at "${this.path}" does not ` +
        `cover this text — regenerate it with \`pnpm corpus:vectors\` if the corpus or ` +
        `CHUNK_SIZE changed, and note that EMBEDDING_PROVIDER=precomputed cannot embed ` +
        `anything outside the corpus (a question, a memory fact).`,
    );
  }
}

function parseVectorFile(raw: string, path: string): PrecomputedVectorFile {
  const parsed: unknown = JSON.parse(raw);

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as PrecomputedVectorFile).modelId !== 'string' ||
    typeof (parsed as PrecomputedVectorFile).dimensions !== 'number' ||
    typeof (parsed as PrecomputedVectorFile).generatedAt !== 'string' ||
    typeof (parsed as PrecomputedVectorFile).vectors !== 'object' ||
    (parsed as PrecomputedVectorFile).vectors === null
  ) {
    throw new Error(
      `"${path}" is not a vector artifact — regenerate it with \`pnpm corpus:vectors\``,
    );
  }

  return parsed as PrecomputedVectorFile;
}
