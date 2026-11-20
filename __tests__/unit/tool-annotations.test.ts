/**
 * MCP tool-design standard: every advertised tool has a title, honest
 * annotations, and a description of at most 300 characters.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const MAX_DESCRIPTION_CHARS = 300;

const CANONICAL_TOOLS = 15;

const EXPECTED_ANNOTATIONS: Record<
  string,
  {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  }
> = {
  evernote_create_note: {
    title: "Create note",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  evernote_search_notes: {
    title: "Search notes",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  evernote_get_note: {
    title: "Get note",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  evernote_update_note: {
    title: "Update note",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  evernote_delete_note: {
    title: "Delete or restore note",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  evernote_list_notebooks: {
    title: "List notebooks",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  evernote_create_notebook: {
    title: "Create notebook",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  evernote_list_tags: {
    title: "List tags",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  evernote_create_tag: {
    title: "Create tag",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  evernote_connection: {
    title: "Manage connection",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  evernote_polling: {
    title: "Manage polling",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  evernote_get_resource: {
    title: "Get attachment",
    // saveToPath writes a local file, so this is not a pure read.
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  evernote_add_resource_to_note: {
    title: "Add attachment",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  evernote_update_notebook: {
    title: "Update notebook",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  evernote_update_tag: {
    title: "Update tag",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

interface ParsedTool {
  name: string;
  title?: string;
  description: string;
  annotations: Record<string, boolean>;
}


function extractString(block: string, field: string): string | undefined {
  const re = new RegExp(
    `${field}:\\s*((?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\\s|\\+)*)`,
  );
  const match = block.match(re);
  if (!match) {
    return undefined;
  }
  const parts = [...match[1].matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g)];
  if (parts.length === 0) {
    return undefined;
  }
  return parts.map((part) => {
    const raw = part[0];
    if (raw.startsWith("'")) {
      return raw.slice(1, -1).replace(/\\'/g, "'").replace(/\\n/g, "\n");
    }
    return JSON.parse(raw) as string;
  }).join("");
}

function extractAnnotations(block: string): Record<string, boolean> {
  const match = block.match(/annotations:\s*\{([^}]+)\}/);
  if (!match) {
    return {};
  }
  const out: Record<string, boolean> = {};
  for (const line of match[1].split("\n")) {
    const pair = line.match(/(\w+):\s*(true|false)/);
    if (pair) {
      out[pair[1]] = pair[2] === "true";
    }
  }
  return out;
}

function parseToolsArray(source: string, declaration: string): ParsedTool[] {
  const start = source.indexOf(declaration);
  if (start < 0) {
    throw new Error(`Missing ${declaration}`);
  }
  const after = source.slice(start + declaration.length);
  const end = after.indexOf("\n];");
  if (end < 0) {
    throw new Error(`Unclosed ${declaration}`);
  }
  const body = after.slice(0, end);
  const chunks = body.split(/\n  \{\n    name: "/).slice(1);
  return chunks.map((chunk) => {
    const name = chunk.slice(0, chunk.indexOf('"'));
    const block = `    name: "${chunk}`;
    return {
      name,
      title: extractString(block, "title"),
      description: extractString(block, "description") ?? "",
      annotations: extractAnnotations(block),
    };
  });
}

describe("advertised tool design", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "../../src/index.ts"),
    "utf-8",
  );
  const tools = parseToolsArray(source, "const tools: Tool[] = [");

  it("advertises exactly 15 canonical tools", () => {
    expect(tools.map((tool) => tool.name)).toEqual(Object.keys(EXPECTED_ANNOTATIONS));
    expect(tools).toHaveLength(CANONICAL_TOOLS);
  });

  it("gives every tool a title, honest annotations, and a short description", () => {
    for (const tool of tools) {
      const expected = EXPECTED_ANNOTATIONS[tool.name];
      expect(tool.title).toBe(expected.title);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
      expect(tool.annotations.readOnlyHint).toBe(expected.readOnlyHint);
      expect(tool.annotations.destructiveHint).toBe(expected.destructiveHint);
      if (expected.idempotentHint !== undefined) {
        expect(tool.annotations.idempotentHint).toBe(expected.idempotentHint);
      }
      if (expected.openWorldHint !== undefined) {
        expect(tool.annotations.openWorldHint).toBe(expected.openWorldHint);
      }
      if (tool.annotations.readOnlyHint) {
        expect(tool.annotations.destructiveHint).toBe(false);
      }
    }
  });

  it("marks mutating action tools as not read-only, and never under-reports destructiveness", () => {
    const update = tools.find((tool) => tool.name === "evernote_update_note")!;
    // forceUpdate deletes the original note and creates a replacement.
    expect(update.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });

    const del = tools.find((tool) => tool.name === "evernote_delete_note")!;
    // trash (and the combined tool that also restores) is destructive.
    expect(del.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });

    const connection = tools.find((tool) => tool.name === "evernote_connection")!;
    // action:"revoke" clears the stored auth token.
    expect(connection.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });
});

describe("legacy tool annotations", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "../../src/index.ts"),
    "utf-8",
  );
  const legacy = parseToolsArray(source, "const legacyTools: Tool[] = [");

  it("declares title, readOnlyHint, and destructiveHint on every legacy alias", () => {
    expect(legacy.length).toBeGreaterThan(0);
    for (const tool of legacy) {
      expect(tool.title).toEqual(expect.any(String));
      expect(tool.title!.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
      expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
      expect(typeof tool.annotations.destructiveHint).toBe("boolean");
    }
  });
});
