/**
 * Guardrails for agent-facing writes, kept pure so they can be unit tested
 * without the MCP dispatcher:
 *
 * - Destructive gate: trash/restore (delete_note) and token revocation
 *   (connection action:"revoke", legacy revoke_auth) are only advertised and
 *   callable when EVERNOTE_ENABLE_DESTRUCTIVE=true.
 * - Notebook resolution: unknown notebook names are rejected with close
 *   matches instead of silently creating a new notebook.
 * - Tag paging: list_tags filters and pages a large tag list.
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const DESTRUCTIVE_ENV_FLAG = 'EVERNOTE_ENABLE_DESTRUCTIVE';

/** Tools that are only advertised when the destructive flag is on. */
export const DESTRUCTIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'evernote_delete_note',
  'evernote_revoke_auth',
]);

const CONNECTION_TOOL = 'evernote_connection';
const DESTRUCTIVE_CONNECTION_ACTIONS: ReadonlySet<string> = new Set(['revoke']);

export const GATED_CONNECTION_DESCRIPTION =
  'Manage the Evernote connection and account. action: "status" runs a health/diagnostic check (auth state, config), "user" returns the account profile + quota, "reconnect" forces reinitialization (useful when "Not connected" errors persist).';

export function isDestructiveEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[DESTRUCTIVE_ENV_FLAG] === 'true';
}

/**
 * Drop destructive tools and the connection tool's revoke action from the
 * advertised surface unless the flag is on. Annotations stay honest: without
 * revoke, connection no longer destroys anything.
 */
export function applyDestructiveGate(tools: Tool[], enabled: boolean): Tool[] {
  if (enabled) {
    return tools;
  }
  return tools
    .filter((tool) => !DESTRUCTIVE_TOOL_NAMES.has(tool.name))
    .map((tool) => {
      if (tool.name !== CONNECTION_TOOL) {
        return tool;
      }
      const inputSchema = tool.inputSchema as any;
      const properties = inputSchema.properties ?? {};
      const action = properties.action ?? {};
      return {
        ...tool,
        description: GATED_CONNECTION_DESCRIPTION,
        annotations: { ...tool.annotations, destructiveHint: false },
        inputSchema: {
          ...inputSchema,
          properties: {
            ...properties,
            action: {
              ...action,
              enum: (action.enum ?? []).filter(
                (a: string) => !DESTRUCTIVE_CONNECTION_ACTIONS.has(a),
              ),
            },
          },
        },
      };
    });
}

/**
 * Returns an error message when a call targets a destructive operation while
 * the flag is off, otherwise null. `name`/`args` are the canonical (post-alias)
 * tool name and args; `requestedName` is what the caller actually sent.
 */
export function destructiveCallError(
  name: string,
  args: unknown,
  enabled: boolean,
  requestedName: string = name,
): string | null {
  if (enabled) {
    return null;
  }
  const action =
    args && typeof args === 'object' ? (args as Record<string, unknown>).action : undefined;
  const blocked =
    DESTRUCTIVE_TOOL_NAMES.has(name) ||
    (name === CONNECTION_TOOL &&
      typeof action === 'string' &&
      DESTRUCTIVE_CONNECTION_ACTIONS.has(action));
  if (!blocked) {
    return null;
  }
  const what =
    name === CONNECTION_TOOL ? `${requestedName} action:"${String(action)}"` : requestedName;
  return `${what} is disabled. Set ${DESTRUCTIVE_ENV_FLAG}=true on the server to enable destructive operations.`;
}

// ---------------------------------------------------------------------------
// Notebook resolution
// ---------------------------------------------------------------------------

export interface NamedEntity {
  guid?: string;
  name?: string;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

/**
 * Up to `max` existing names closest to `name`: case-insensitive substring
 * matches first, then small edit distances (typos).
 */
export function closeMatches(name: string, candidates: string[], max = 5): string[] {
  const needle = name.trim().toLowerCase();
  if (!needle) return [];
  const threshold = Math.max(2, Math.floor(needle.length / 3));
  const scored: Array<{ name: string; score: number }> = [];
  for (const candidate of candidates) {
    const hay = candidate.toLowerCase();
    if (hay.includes(needle) || needle.includes(hay)) {
      scored.push({ name: candidate, score: 0 });
      continue;
    }
    const distance = levenshtein(needle, hay);
    if (distance <= threshold) {
      scored.push({ name: candidate, score: distance });
    }
  }
  return scored
    .sort((x, y) => x.score - y.score || x.name.localeCompare(y.name))
    .slice(0, max)
    .map((s) => s.name);
}

/**
 * Find a notebook by exact name, falling back to a unique case-insensitive
 * match (Evernote notebook names are unique case-insensitively, so this is
 * unambiguous). Returns close matches when nothing matches.
 */
export function findNotebookByName<T extends NamedEntity>(
  notebooks: T[],
  name: string,
): { notebook?: T; suggestions: string[] } {
  const exact = notebooks.find((nb) => nb.name === name);
  if (exact) return { notebook: exact, suggestions: [] };
  const lower = name.trim().toLowerCase();
  const folded = notebooks.filter((nb) => nb.name?.trim().toLowerCase() === lower);
  if (folded.length === 1) return { notebook: folded[0], suggestions: [] };
  const names = notebooks.map((nb) => nb.name).filter((n): n is string => !!n);
  return { suggestions: closeMatches(name, names) };
}

export function unknownNotebookMessage(name: string, suggestions: string[]): string {
  const hint = suggestions.length
    ? ` Did you mean: ${suggestions.map((s) => JSON.stringify(s)).join(', ')}?`
    : '';
  return (
    `Notebook "${name}" not found.${hint} ` +
    'Pass createNotebook: true to create it, or use evernote_list_notebooks to see existing names.'
  );
}

// ---------------------------------------------------------------------------
// Tag paging
// ---------------------------------------------------------------------------

export interface TagPageOptions {
  query?: string;
  limit?: number;
  offset?: number;
}

export interface TagPage<T> {
  total: number;
  offset: number;
  limit: number;
  returned: number;
  hasMore: boolean;
  nextOffset?: number;
  tags: T[];
}

/** True when the caller asked for the paged/filtered list shape. */
export function wantsTagPage(options: TagPageOptions): boolean {
  return (
    options.query !== undefined || options.limit !== undefined || options.offset !== undefined
  );
}

/**
 * Case-insensitive substring filter + offset/limit paging. `total` counts the
 * filtered set. Without a limit, everything from offset onward is returned.
 */
export function pageTags<T extends NamedEntity>(tags: T[], options: TagPageOptions): TagPage<T> {
  const needle = options.query?.trim().toLowerCase();
  const filtered = needle
    ? tags.filter((t) => (t.name ?? '').toLowerCase().includes(needle))
    : tags;
  const sorted = [...filtered].sort((a, b) =>
    (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' }),
  );
  const total = sorted.length;
  const offset = Math.max(0, options.offset ?? 0);
  const limit = options.limit ?? Math.max(0, total - offset);
  const page = sorted.slice(offset, offset + limit);
  const end = offset + page.length;
  const hasMore = end < total;
  return {
    total,
    offset,
    limit,
    returned: page.length,
    hasMore,
    ...(hasMore ? { nextOffset: end } : {}),
    tags: page,
  };
}
