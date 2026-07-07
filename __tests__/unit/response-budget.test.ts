import { describe, it, expect } from "@jest/globals";
import {
  applyCharBudget,
  BudgetedNote,
} from "../../src/response-budget.js";

describe("applyCharBudget", () => {
  it("passes notes through untouched when under budget", () => {
    const notes: BudgetedNote[] = [
      { guid: "a", content: "abc" },
      { guid: "b", content: "de" },
    ];
    const res = applyCharBudget(notes, 100);
    expect(res.truncatedCount).toBe(0);
    expect(res.notes).toEqual(notes);
  });

  it("clips the note that crosses the budget, preserving contentLength", () => {
    const notes: BudgetedNote[] = [
      { guid: "a", content: "aaaa" }, // 4 → fits, used = 4
      { guid: "b", content: "bbbbbb" }, // 6, remaining 2 → clipped to "bb"
    ];
    const res = applyCharBudget(notes, 6);
    expect(res.truncatedCount).toBe(1);
    expect(res.notes[0].content).toBe("aaaa");
    expect(res.notes[1].content).toBe("bb");
    expect(res.notes[1].truncated).toBe(true);
    expect(res.notes[1].contentLength).toBe(6);
  });

  it("drops content entirely for notes past an exhausted budget", () => {
    const notes: BudgetedNote[] = [
      { guid: "a", content: "aaaaaa" }, // 6 → exact fit, used = 6
      { guid: "b", content: "bbbb" }, // budget spent → content dropped
    ];
    const res = applyCharBudget(notes, 6);
    expect(res.notes[0].content).toBe("aaaaaa");
    expect(res.notes[1].content).toBeUndefined();
    expect(res.notes[1].truncated).toBe(true);
    expect(res.notes[1].contentLength).toBe(4);
    expect(res.truncatedCount).toBe(1);
  });

  it("ignores notes without string content", () => {
    const notes = [{ guid: "a" }, { guid: "b", content: "xy" }];
    const res = applyCharBudget(notes, 100);
    expect(res.truncatedCount).toBe(0);
    expect(res.notes[0]).toEqual({ guid: "a" });
    expect(res.notes[1].content).toBe("xy");
  });

  it("treats a non-finite budget as unlimited (no clipping)", () => {
    const notes: BudgetedNote[] = [{ guid: "a", content: "keep me whole" }];
    const res = applyCharBudget(notes, Number.NaN);
    expect(res.truncatedCount).toBe(0);
    expect(res.notes[0].content).toBe("keep me whole");
  });
});
