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

    saveQuestionExpansionChoices("repo", choices);

    const serialized = window.localStorage.getItem(questionExpansionStorageKey("repo")) ?? "";
    const restored = readQuestionExpansionChoices("repo");
    expect(serialized.length).toBeLessThanOrEqual(30_000);
    expect(Object.keys(restored)).toHaveLength(256);
    expect(restored["question-999"]).toBe(false);
    expect(restored).toEqual(choices);
  });
});
