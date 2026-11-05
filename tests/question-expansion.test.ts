// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";

import {
  questionExpansionStorageKey,
  readQuestionExpansionChoices,
  saveQuestionExpansionChoices,
  updateQuestionExpansionChoices,
  type QuestionExpansionChoices,
} from "../src/ui/question-expansion";

describe("question expansion persistence", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("keeps recent choices while bounding long-lived repository storage", () => {
    let choices: QuestionExpansionChoices = {};
    for (let index = 0; index < 1_000; index += 1) {
      choices = updateQuestionExpansionChoices(choices, `question-${index}`, index % 2 === 0);
    }

    saveQuestionExpansionChoices(window.localStorage, "repo", choices);

    const serialized = window.localStorage.getItem(questionExpansionStorageKey("repo")) ?? "";
    const restored = readQuestionExpansionChoices(window.localStorage, "repo");
    expect(serialized.length).toBeLessThanOrEqual(30_000);
    expect(Object.keys(restored)).toHaveLength(256);
    expect(restored["question-999"]).toBe(false);
    expect(restored).toEqual(choices);
  });

  it("keeps choices in memory only when the source has no storage", () => {
    const choices = updateQuestionExpansionChoices({}, "question-1", true);

    saveQuestionExpansionChoices(null, "demo", choices);

    expect(readQuestionExpansionChoices(null, "demo")).toEqual({});
    expect(Object.keys(window.localStorage)).toEqual([]);
  });
});
