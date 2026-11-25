import { describe, expect, it } from "vitest";
import { toolInputSchema } from "./contracts.js";
import { NOT_UNIQUE_MESSAGE } from "./tool-definition.js";
import {
  MAX_INTERACTION_PAYLOAD_BYTES,
  assertInteractionPayloadFits,
  buildInteractionPayload,
  buildInteractionTitle,
  buildToolResult,
  describeAnswers,
  validateToolInput,
} from "./translate.js";

function parseInput(input: unknown) {
  const parsed = toolInputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`invalid fixture: ${parsed.error}`);
  return parsed.data;
}

const twoOptions = [
  { label: "Postgres", description: "Relational, needs a server." },
  { label: "SQLite", description: "Embedded, zero setup." },
];

describe("tool input validation", () => {
  it("rejects duplicate prompts, which would collapse into one answer key", () => {
    expect(
      validateToolInput(
        parseInput({
          questions: [
            { question: "Same?", header: "A", options: twoOptions },
            { question: "Same?", header: "B", options: twoOptions },
          ],
        }),
      ),
    ).toBe(NOT_UNIQUE_MESSAGE);
  });

  it("rejects duplicate option labels within one question", () => {
    expect(
      validateToolInput(
        parseInput({
          questions: [
            {
              question: "Which DB?",
              header: "DB",
              options: [
                { label: "Postgres", description: "Managed." },
                { label: "Postgres", description: "Self-hosted." },
              ],
            },
          ],
        }),
      ),
    ).toBe(NOT_UNIQUE_MESSAGE);
  });
});

describe("buildInteractionPayload", () => {
  it("assigns stable ids, keeps option order, and always allows free text", () => {
    const payload = buildInteractionPayload(
      parseInput({
        questions: [
          { question: "Which DB?", header: "DB", options: twoOptions },
          {
            question: "Which cache?",
            header: "Cache",
            multiSelect: true,
            options: [
              { label: "Redis", description: "In-memory." },
              { label: "None", description: "Skip caching." },
            ],
          },
        ],
      }),
    );

    expect(payload.questions.map((question) => question.id)).toEqual([
      "q0",
      "q1",
    ]);
    expect(payload.questions[0]).toMatchObject({
      prompt: "Which DB?",
      shortLabel: "DB",
      multiSelect: false,
      allowFreeText: true,
    });
    expect(payload.questions[0]?.options.map((option) => option.value)).toEqual(
      ["q0o0", "q0o1"],
    );
    expect(payload.questions[1]?.multiSelect).toBe(true);
    expect(payload.questions[1]?.options[0]?.value).toBe("q1o0");
  });

  it("drops previews on multiSelect questions, which do not support them", () => {
    const payload = buildInteractionPayload(
      parseInput({
        questions: [
          {
            question: "Which extras?",
            header: "Extras",
            multiSelect: true,
            options: [
              { label: "Metrics", description: "Prometheus.", preview: "up{}" },
              { label: "Tracing", description: "OTel.", preview: "span" },
            ],
          },
        ],
      }),
    );
    expect(
      payload.questions[0]?.options.map((option) => option.preview),
    ).toEqual([undefined, undefined]);
  });

  it("drops blank previews instead of forwarding empty preview blocks", () => {
    const payload = buildInteractionPayload(
      parseInput({
        questions: [
          {
            question: "Which layout?",
            header: "Layout",
            options: [
              { label: "Grid", description: "Cards.", preview: "   \n  " },
              { label: "List", description: "Rows.", preview: "  a | b  " },
            ],
          },
        ],
      }),
    );
    expect(payload.questions[0]?.options[0]?.preview).toBeUndefined();
    expect(payload.questions[0]?.options[1]?.preview).toBe("a | b");
  });
});

describe("assertInteractionPayloadFits", () => {
  it("accepts a realistic payload", () => {
    const payload = buildInteractionPayload(
      parseInput({
        questions: [
          {
            question: "Which DB?",
            header: "DB",
            options: [
              {
                label: "Postgres",
                description: "Server.",
                preview: "x".repeat(2000),
              },
              { label: "SQLite", description: "Embedded." },
            ],
          },
        ],
      }),
    );
    expect(() => assertInteractionPayloadFits(payload)).not.toThrow();
    expect(
      new TextEncoder().encode(JSON.stringify(payload)).length,
    ).toBeLessThan(MAX_INTERACTION_PAYLOAD_BYTES);
  });
});

describe("buildInteractionTitle", () => {
  it("uses the header for one question and a count for several", () => {
    const single = buildInteractionPayload(
      parseInput({
        questions: [
          { question: "Which DB?", header: "Database", options: twoOptions },
        ],
      }),
    );
    expect(buildInteractionTitle(single)).toBe("Database");

    const multiple = buildInteractionPayload(
      parseInput({
        questions: [
          { question: "Which DB?", header: "DB", options: twoOptions },
          { question: "Which cache?", header: "Cache", options: twoOptions },
        ],
      }),
    );
    expect(buildInteractionTitle(multiple)).toBe("2 questions");
  });
});

describe("buildToolResult", () => {
  const payload = buildInteractionPayload(
    parseInput({
      questions: [
        {
          question: "Which DB?",
          header: "DB",
          options: [
            {
              label: "Postgres",
              description: "Server.",
              preview: "CREATE TABLE t();",
            },
            { label: "SQLite", description: "Embedded." },
          ],
        },
        {
          question: "Which extras?",
          header: "Extras",
          multiSelect: true,
          options: [
            { label: "Metrics", description: "Prometheus." },
            { label: "Tracing", description: "OTel." },
          ],
        },
      ],
    }),
  );

  it("keys answers by question text, matching the native Claude result", () => {
    const result = buildToolResult(payload, {
      answers: {
        q0: { selected: ["q0o1"] },
        q1: { selected: ["q1o0", "q1o1"] },
      },
    });

    expect(result.answers).toEqual({
      "Which DB?": "SQLite",
      "Which extras?": "Metrics, Tracing",
    });
    expect(result.annotations).toBeUndefined();
    expect(result.questions[0]).toEqual({
      question: "Which DB?",
      header: "DB",
      multiSelect: false,
      options: [
        {
          label: "Postgres",
          description: "Server.",
          preview: "CREATE TABLE t();",
        },
        { label: "SQLite", description: "Embedded." },
      ],
    });
  });

  it("returns free text alone as the whole answer, with no redundant note", () => {
    const result = buildToolResult(payload, {
      answers: {
        q0: { selected: [], freeText: "DuckDB" },
        q1: { selected: [] },
      },
    });

    expect(result.answers["Which DB?"]).toBe("DuckDB");
    expect(result.annotations).toBeUndefined();
    expect(result.response).toBeUndefined();
  });

  it("sets `response` when a lone question is answered with free text only", () => {
    const single = buildInteractionPayload(
      parseInput({
        questions: [
          { question: "Which DB?", header: "DB", options: twoOptions },
        ],
      }),
    );
    const result = buildToolResult(single, {
      answers: { q0: { selected: [], freeText: "DuckDB" } },
    });

    expect(result.response).toBe("DuckDB");
    expect(result.answers["Which DB?"]).toBe("DuckDB");
  });

  it("ignores selections that do not match any option value", () => {
    const result = buildToolResult(payload, {
      answers: { q0: { selected: ["bogus"] }, q1: { selected: ["q1o1"] } },
    });

    expect(result.answers).not.toHaveProperty("Which DB?");
    expect(result.answers["Which extras?"]).toBe("Tracing");
  });
});

describe("describeAnswers", () => {
  function describeWithinHostLimits(
    questions: { question: string; header: string }[],
    answers: Record<string, { selected: string[]; freeText?: string }>,
  ) {
    const payload = buildInteractionPayload(
      parseInput({
        questions: questions.map((question) => ({
          ...question,
          options: twoOptions,
        })),
      }),
    );
    const description = describeAnswers(
      payload,
      buildToolResult(payload, { answers }),
    );
    expect(description.title.length).toBeLessThanOrEqual(160);
    expect(description.detail.length).toBeLessThanOrEqual(280);
    return description;
  }

  it("titles a long question by its header and keeps the whole question in the detail", () => {
    const question =
      "PR #246 is green, and every CI job passed. Merging it starts a production deploy. Should I merge it and then measure prod against the baseline?";
    const description = describeWithinHostLimits(
      [{ question, header: "Merge #246" }],
      {
        q0: { selected: ["q0o0"] },
      },
    );

    expect(description.title).toBe("Answered Merge #246 — Postgres");
    expect(description.detail).toBe(`- ${question} — Postgres`);
  });

  it("shortens a long free-text answer to fit the title", () => {
    const answer = `Neither. ${"Use the managed queue we already run. ".repeat(12)}`;
    const description = describeWithinHostLimits(
      [{ question: "Which database should we use?", header: "Database" }],
      { q0: { selected: [], freeText: answer } },
    );

    expect(description.title).toMatch(
      /^Answered Database — Neither\. Use the .+…$/,
    );
  });

  it("keeps every answer in the detail when several long questions overflow it", () => {
    const questions = ["schema", "cache", "deploy"].map((topic) => ({
      question: `Before I change the ${topic}, which of these options should I take, given everything we found in the investigation so far and the constraints you listed earlier?`,
      header: topic,
    }));
    const description = describeWithinHostLimits(questions, {
      q0: { selected: ["q0o0"] },
      q1: { selected: ["q1o1"] },
      q2: { selected: [], freeText: "Ask me again tomorrow" },
    });

    expect(description.detail.split("\n")).toEqual([
      expect.stringMatching(/^- Before I change the schema, .+… — Postgres$/),
      expect.stringMatching(/^- Before I change the cache, .+… — SQLite$/),
      expect.stringMatching(
        /^- Before I change the deploy, .+… — Ask me again tomorrow$/,
      ),
    ]);
  });
});
