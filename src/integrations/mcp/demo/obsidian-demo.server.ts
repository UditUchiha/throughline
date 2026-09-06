import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { searchVault, type VaultNote } from './vault-search';

/**
 * The synthetic counterpart to a live Obsidian MCP server (PLAN.md §5/M5,
 * "Non-negotiable: demo-mode fallback").
 *
 * The important word is *counterpart*, not *stub*. This is a real
 * `@modelcontextprotocol/sdk` server: it advertises a tool over the real
 * protocol, declares a real input schema, and is reached through the same
 * `Client` the live path uses — only the transport differs (in-memory instead of
 * a stdio child process) and only the data is bundled. Everything M5 claims to
 * have built is therefore exercised by the deployed demo, including the parts
 * that would be easiest to get wrong and never notice: discovery, query-argument
 * resolution, argument validation, result adaptation.
 *
 * A hand-rolled fake object implementing `AgentTool` would have been a tenth of
 * the code and would have proved nothing.
 */
export const DEMO_VAULT_TOOL_NAME = 'search_notes';

/**
 * Written for the planner, which reads it alongside `notes_search` and has to
 * tell the two apart. The distinction that matters is whose notes these are:
 * shared meeting notes are the corpus, this is one person's own vault.
 */
const DEMO_VAULT_TOOL_DESCRIPTION =
  "Search the owner's personal Obsidian vault — private working notes, daily notes and " +
  'drafts kept outside the company mail, chat and meeting notes. Best for what one person ' +
  'individually observed, decided or intended to do, and for first-person context that no ' +
  'shared document would record.';

/** Result cap the server enforces regardless of what it is asked for. */
const MAX_RESULTS = 10;

export function createDemoVaultServer(notes: VaultNote[]): McpServer {
  const server = new McpServer({ name: 'throughline-demo-vault', version: '1.0.0' });

  server.registerTool(
    DEMO_VAULT_TOOL_NAME,
    {
      title: 'Search personal notes',
      description: DEMO_VAULT_TOOL_DESCRIPTION,
      inputSchema: {
        query: z.string().describe('Natural-language description of the information sought.'),
        topK: z.number().int().positive().optional().describe('Maximum notes to return.'),
      },
    },
    ({ query, topK }) => {
      const hits = searchVault(notes, query, Math.min(topK ?? 5, MAX_RESULTS));

      return {
        // Both shapes, on purpose. `structuredContent` is what this system reads,
        // and it is the reason connector evidence carries a real relevance rather
        // than a rank; the text block is what any other MCP client would render,
        // and leaving it out would make this a server only we can talk to.
        structuredContent: {
          results: hits.map((hit) => ({
            path: hit.path,
            title: hit.title,
            text: hit.text,
            score: hit.score,
          })),
        },
        content: [
          {
            type: 'text' as const,
            text:
              hits.length === 0
                ? 'No matching notes.'
                : hits.map((hit) => `## ${hit.title} (${hit.path})\n${hit.text}`).join('\n\n'),
          },
        ],
      };
    },
  );

  return server;
}

/**
 * Reads a directory of markdown as vault notes.
 *
 * Deliberately not reusing `src/knowledge/`'s loader. That one exists to feed the
 * indexer and knows about corpus frontmatter and chunking; this stands in for a
 * third-party server that has never heard of any of it, and sharing code between
 * them would quietly make the demo easier than the live path it represents.
 */
export function loadVault(vaultPath: string): VaultNote[] {
  return listMarkdown(vaultPath).map((absolutePath) => {
    const raw = readFileSync(absolutePath, 'utf8');
    const parsed = matter(raw);
    const body = parsed.content.trim();
    const path = relative(vaultPath, absolutePath).split(sep).join('/');

    return {
      path,
      title: frontmatterTitle(parsed.data) ?? headingTitle(body) ?? path.replace(/\.md$/, ''),
      text: body,
    };
  });
}

function listMarkdown(directory: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory)) {
    const absolutePath = join(directory, entry);
    if (statSync(absolutePath).isDirectory()) {
      found.push(...listMarkdown(absolutePath));
    } else if (entry.endsWith('.md')) {
      found.push(absolutePath);
    }
  }

  return found.sort();
}

function frontmatterTitle(data: Record<string, unknown>): string | undefined {
  return typeof data.title === 'string' && data.title.trim() ? data.title.trim() : undefined;
}

function headingTitle(body: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(body);
  return match?.[1]?.trim();
}
