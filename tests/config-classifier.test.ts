import { describe, expect, test } from "bun:test";
import { loadProfile, parseProfile, getQuestion } from "@discovery/config";
import { classifyStatement, validateClassification } from "@discovery/ai";

const en = await loadProfile("examples/instances/open-forum-en.json");
const es = await loadProfile("examples/instances/open-forum-es.json");
const input = (statementText: string, profile = en) => ({
  statementText,
  questionText: profile.questions[0]!.text,
  locale: profile.locale,
  choices: profile.questions[0]!.choices,
});

describe("neutral profile and classifier", () => {
  test("profiles have different languages, answer sets and qualification labels", () => {
    expect(en.locale).toBe("en");
    expect(es.locale).toBe("es");
    expect(en.questions[0]!.choices).toHaveLength(3);
    expect(es.questions[0]!.choices).toHaveLength(2);
    expect(en.qualificationLabel).not.toBe(es.qualificationLabel);
  });
  test("English and Spanish use profile-owned keywords and ids", async () => {
    const english = await classifyStatement(
      input("A hearing should be required."),
    );
    const spanish = await classifyStatement(
      input("LA AUDIENCIA DEBE SER OPCIONAL.", es),
    );
    expect(english.suggested_choice_id).toBe(en.questions[0]!.choices[0]!.id);
    expect(spanish.suggested_choice_id).toBe(es.questions[0]!.choices[1]!.id);
    expect(english.requires_human_review).toBe(true);
    expect(spanish.requires_human_review).toBe(true);
  });
  test("an answer appearing only in the question is not statement evidence", async () => {
    const value = input("I have not expressed a view.");
    value.questionText = "A hearing should be required.";
    const result = await classifyStatement(value);
    expect(result.suggested_choice_id).toBeUndefined();
    expect(result.should_count).toBe(false);
  });
  test("conflicting keyword matches abstain", async () => {
    const result = await classifyStatement(
      input(
        "Some say a hearing should be required; others say a hearing should be optional.",
      ),
    );
    expect(result.suggested_choice_id).toBeUndefined();
    expect(result.should_count).toBe(false);
    expect(result.alternative_choices).toHaveLength(2);
  });
  test("invalid locales, duplicate ids and unknown profile fields are rejected", () => {
    expect(() => parseProfile({ ...en, locale: "invalid_locale" })).toThrow();
    expect(() => parseProfile({ ...en, unexpected: "value" })).toThrow();
    const duplicate = structuredClone(en);
    duplicate.questions[0]!.choices[1]!.id =
      duplicate.questions[0]!.choices[0]!.id;
    expect(() => parseProfile(duplicate)).toThrow("unique");
    expect(() => getQuestion(en, "nonexistent")).toThrow();
  });
  test("adapter output cannot opt out of review, forge evidence, or choose another question's answer", async () => {
    const value = input("A hearing should be required.");
    const result = await classifyStatement(value);
    expect(() =>
      validateClassification(value, {
        ...result,
        requires_human_review: false,
      }),
    ).toThrow();
    expect(() =>
      validateClassification(value, {
        ...result,
        evidence_excerpt: "Invented quotation",
      }),
    ).toThrow("excerpt");
    expect(() =>
      validateClassification(value, {
        ...result,
        suggested_choice_id: es.questions[0]!.choices[0]!.id,
      }),
    ).toThrow("outside");
    expect(() =>
      validateClassification(value, {
        ...result,
        alternative_choices: [
          { choice_id: es.questions[0]!.choices[0]!.id, reason: "Other" },
        ],
      }),
    ).toThrow("outside");
  });
});
