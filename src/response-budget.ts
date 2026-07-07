/**
 * Cap the total character weight of note bodies in a multi-note response so it
 * stays under the MCP response token cap (~25k tokens). Notes are walked in
 * order: once the budget is spent, later notes keep their metadata but drop
 * their content, each flagged `truncated: true` with the original
 * `contentLength` preserved so the caller can re-fetch the full note.
 */

export const DEFAULT_MAX_RESPONSE_CHARS = 60000;

export interface BudgetedNote {
  content?: string;
  contentLength?: number;
  truncated?: boolean;
  [key: string]: any;
}

export interface CharBudgetResult<T> {
  notes: T[];
  truncatedCount: number;
}

/**
 * Apply a total content-character budget across `notes` (in order). Notes with
 * no string `content` are passed through untouched and cost nothing.
 */
export function applyCharBudget<T extends BudgetedNote>(
  notes: T[],
  budgetChars: number,
): CharBudgetResult<T> {
  let used = 0;
  let truncatedCount = 0;

  const out = notes.map((note) => {
    if (typeof note.content !== "string") {
      return note;
    }
    const originalLength = note.contentLength ?? note.content.length;

    if (used >= budgetChars) {
      // Budget already spent: drop this note's body entirely.
      truncatedCount++;
      return {
        ...note,
        content: undefined,
        contentLength: originalLength,
        truncated: true,
      };
    }

    const remaining = budgetChars - used;
    if (note.content.length <= remaining) {
      used += note.content.length;
      return note;
    }

    // Partial clip: this note pushes past the budget.
    used = budgetChars;
    truncatedCount++;
    return {
      ...note,
      content: note.content.slice(0, remaining),
      contentLength: originalLength,
      truncated: true,
    };
  });

  return { notes: out, truncatedCount };
}
