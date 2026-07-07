/**
 * Tool-alias shim for the tool-surface consolidation.
 *
 * As tools are retired from the advertised surface, their names stay callable:
 * TOOL_ALIASES maps each retired name to a canonical tool plus a `mapArgs` that
 * rewrites the old arg shape (renamed params, injected discriminators) into the
 * canonical schema's shape. `resolveToolAlias()` runs in the CallTool dispatcher
 * BEFORE Zod validation, so retired calls validate against — and route to — the
 * canonical handler.
 *
 * The map is intentionally empty until later PRs retire tools; the plumbing
 * ships first so the dispatcher change is reviewed in isolation (no behavior
 * change while the map is empty).
 */

export interface ToolAlias {
  /** Canonical tool name the retired alias routes to. */
  canonical: string;
  /** Rewrites the retired tool's args into the canonical schema's shape. */
  mapArgs: (args: any) => any;
  /**
   * Representative old-shape args. Used by tool-aliases.test.ts to assert that
   * `mapArgs` output validates against the canonical tool's Zod schema.
   */
  sampleArgs?: Record<string, unknown>;
}

/**
 * Retired tool name -> canonical routing. Empty until tools are retired by the
 * consolidation PRs (resources, polling, connection, notebooks/tags, notes).
 */
export const TOOL_ALIASES: Record<string, ToolAlias> = {};

export interface ResolvedTool {
  /** Canonical tool name to dispatch. */
  name: string;
  /** Args in the canonical tool's shape (rewritten when aliased). */
  args: unknown;
  /** True when `name` came from a retired alias. */
  aliased: boolean;
}

/**
 * Resolve a possibly-retired tool name to its canonical name + rewritten args.
 * Non-aliased names pass through unchanged. Safe on undefined args.
 */
export function resolveToolAlias(
  name: string,
  args: unknown,
  aliases: Record<string, ToolAlias> = TOOL_ALIASES,
): ResolvedTool {
  const alias = aliases[name];
  if (!alias) {
    return { name, args, aliased: false };
  }
  return { name: alias.canonical, args: alias.mapArgs(args ?? {}), aliased: true };
}
