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
export const TOOL_ALIASES: Record<string, ToolAlias> = {
  // Resources 5 -> 2 (PR 1): get_resource projects via `as`; list_note_resources
  // is dropped in favor of get_note's resources[] metadata.
  evernote_get_resource_text: {
    canonical: 'evernote_get_resource',
    mapArgs: (a) => ({ guid: a.resourceGuid, as: 'text' }),
    sampleArgs: { resourceGuid: 'r1' },
  },
  evernote_get_resource_recognition: {
    canonical: 'evernote_get_resource',
    mapArgs: (a) => ({ guid: a.resourceGuid, as: 'recognition' }),
    sampleArgs: { resourceGuid: 'r1' },
  },
  // NOTE: evernote_list_note_resources is intentionally NOT aliased. Its old
  // response was a top-level array (with hash/hasRecognition), which get_note's
  // nested resources[] can't reproduce, so it is kept as a hidden, shape-exact
  // legacy handler in the dispatcher instead (still off the default surface).

  // Polling 4 -> 1 (PR 2): evernote_polling({ action }).
  evernote_start_polling: {
    canonical: 'evernote_polling',
    mapArgs: () => ({ action: 'start' }),
  },
  evernote_stop_polling: {
    canonical: 'evernote_polling',
    mapArgs: () => ({ action: 'stop' }),
  },
  evernote_poll_now: {
    canonical: 'evernote_polling',
    mapArgs: () => ({ action: 'poll' }),
  },
  evernote_polling_status: {
    canonical: 'evernote_polling',
    mapArgs: () => ({ action: 'status' }),
  },

  // Connection/account 4 -> 1 (PR 3): evernote_connection({ action }).
  evernote_health_check: {
    canonical: 'evernote_connection',
    mapArgs: (a) => ({ action: 'status', verbose: a.verbose }),
    sampleArgs: { verbose: true },
  },
  evernote_reconnect: {
    canonical: 'evernote_connection',
    mapArgs: () => ({ action: 'reconnect' }),
  },
  evernote_revoke_auth: {
    canonical: 'evernote_connection',
    mapArgs: () => ({ action: 'revoke' }),
  },
  evernote_get_user_info: {
    canonical: 'evernote_connection',
    mapArgs: () => ({ action: 'user' }),
  },

  // Notebooks/tags list-absorbs-get (PR 4): list_* returns one entity when
  // name/guid is supplied, else the full list.
  evernote_get_notebook: {
    canonical: 'evernote_list_notebooks',
    mapArgs: (a) => ({ name: a.name, guid: a.guid }),
    sampleArgs: { name: 'Finance' },
  },
  evernote_get_tag: {
    canonical: 'evernote_list_tags',
    mapArgs: (a) => ({ name: a.name, guid: a.guid }),
    sampleArgs: { name: 'important' },
  },

  // Notes 6 -> 5 (PR 5): patch_note folds into update_note's patch mode.
  evernote_patch_note: {
    canonical: 'evernote_update_note',
    mapArgs: (a) => ({ guid: a.guid, replacements: a.replacements }),
    sampleArgs: { guid: 'n1', replacements: [{ find: 'a', replace: 'b' }] },
  },
};

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
