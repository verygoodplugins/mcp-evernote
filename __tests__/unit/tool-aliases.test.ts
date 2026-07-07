/**
 * Tests for the tool-alias shim (tool-surface consolidation, PR 0).
 *
 * The production TOOL_ALIASES map is empty until later PRs retire tools and add
 * entries. These tests prove the resolution mechanism with a fixture map, and
 * enforce two invariants over the production map that guard every future alias:
 *   1. each alias.canonical is a real tool that has a Zod schema, and
 *   2. each alias.mapArgs(sampleArgs) validates against that canonical schema.
 */
import { resolveToolAlias, TOOL_ALIASES, ToolAlias } from '../../src/tool-aliases';
import { toolSchemas } from '../../src/tool-schemas';

describe('tool-aliases', () => {
  describe('resolveToolAlias (mechanism)', () => {
    const fixture: Record<string, ToolAlias> = {
      old_text_tool: {
        canonical: 'evernote_get_resource',
        mapArgs: (a: any) => ({ guid: a.resourceGuid, as: 'text' }),
      },
      old_status: {
        canonical: 'evernote_polling',
        mapArgs: () => ({ action: 'status' }),
      },
    };

    it('passes a non-aliased (canonical) name through unchanged', () => {
      const r = resolveToolAlias('evernote_get_note', { guid: 'x' }, fixture);
      expect(r.aliased).toBe(false);
      expect(r.name).toBe('evernote_get_note');
      expect(r.args).toEqual({ guid: 'x' });
    });

    it('rewrites a known alias to its canonical name and maps its args', () => {
      const r = resolveToolAlias('old_text_tool', { resourceGuid: 'abc' }, fixture);
      expect(r.aliased).toBe(true);
      expect(r.name).toBe('evernote_get_resource');
      expect(r.args).toEqual({ guid: 'abc', as: 'text' });
    });

    it('tolerates undefined args on an alias', () => {
      const r = resolveToolAlias('old_status', undefined, fixture);
      expect(r.aliased).toBe(true);
      expect(r.name).toBe('evernote_polling');
      expect(r.args).toEqual({ action: 'status' });
    });

    it('surfaces requireOneOf from the matched alias', () => {
      const withGuard: Record<string, ToolAlias> = {
        old_get: {
          canonical: 'evernote_list_notebooks',
          mapArgs: (a: any) => ({ name: a.name, guid: a.guid }),
          requireOneOf: ['name', 'guid'],
        },
      };
      expect(resolveToolAlias('old_get', {}, withGuard).requireOneOf).toEqual([
        'name',
        'guid',
      ]);
      // Non-aliased and guard-less aliases carry no requireOneOf.
      expect(resolveToolAlias('evernote_get_note', {}, withGuard).requireOneOf).toBeUndefined();
    });

    it('defaults to the production TOOL_ALIASES map when none is passed', () => {
      // Production map is empty in PR 0, so every name resolves to itself.
      const r = resolveToolAlias('evernote_create_note', { title: 't', content: 'c' });
      expect(r.aliased).toBe(false);
      expect(r.name).toBe('evernote_create_note');
    });
  });

  describe('production TOOL_ALIASES invariants', () => {
    const entries = Object.entries(TOOL_ALIASES);

    it('exposes a valid record', () => {
      expect(TOOL_ALIASES).toBeDefined();
      expect(typeof TOOL_ALIASES).toBe('object');
    });

    // A plain loop registers zero tests while the map is empty (PR 0) and
    // activates one assertion per alias as later PRs add entries.
    for (const [aliasName, alias] of entries) {
      it(`alias ${aliasName} targets a canonical tool that has a schema`, () => {
        expect(toolSchemas[alias.canonical]).toBeDefined();
      });

      it(`alias ${aliasName} maps sample args that pass the canonical schema`, () => {
        const schema = toolSchemas[alias.canonical];
        expect(() => schema.parse(alias.mapArgs(alias.sampleArgs ?? {}))).not.toThrow();
      });
    }
  });
});
