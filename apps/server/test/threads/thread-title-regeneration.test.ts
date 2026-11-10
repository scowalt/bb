import { getThread, setAiServiceSelection, threads } from "@bb/db";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import { eq } from "drizzle-orm";
import {
  defaultAppSettings,
  encodeClientTurnRequestIdNumber,
  threadSchema,
  threadScope,
  turnScope,
  type PromptInput,
  type SystemMessageKind,
  type ThreadTurnInitiator,
  type TurnRequestTarget,
} from "@bb/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { internalAuthHeaders } from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedStoredEvent,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import {
  withTestHarness as withBaseHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";
import { registerFakeAiService } from "../helpers/ai-services.js";

const completeTitle = vi.fn<(prompt: string) => Promise<string>>();

function withTitleService<T>(
  run: (harness: TestAppHarness) => Promise<T>,
): Promise<T> {
  return withBaseHarness({}, (harness) => {
    registerFakeAiService(harness.deps.aiServices, {
      id: "codex",
      pluginId: "provider-codex",
      builtin: true,
      complete: (prompt) => completeTitle(prompt),
    });
    return run(harness);
  });
}

function sentPrompt(): string {
  return completeTitle.mock.calls[0]?.[0] ?? "";
}

interface SeedTurnRequestArgs {
  initiator: ThreadTurnInitiator;
  input: PromptInput[];
  sequence: number;
  systemMessageKind?: SystemMessageKind;
  target: TurnRequestTarget;
  threadId: string;
}

function seedTurnRequest(
  harness: TestAppHarness,
  args: SeedTurnRequestArgs,
): void {
  seedEvent(harness.deps, {
    threadId: args.threadId,
    sequence: args.sequence,
    type: "client/turn/requested",
    scope: threadScope(),
    data: {
      direction: "outbound",
      requestId: encodeClientTurnRequestIdNumber({ value: args.sequence }),
      input: args.input,
      target: args.target,
      execution: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
        source: "client/turn/requested",
      },
      initiator: args.initiator,
      senderThreadId: null,
      ...(args.systemMessageKind === undefined
        ? {}
        : { systemMessageKind: args.systemMessageKind }),
      request: {
        method:
          args.target.kind === "thread-start" ? "thread/start" : "turn/start",
        params: {},
      },
      source: args.target.kind === "thread-start" ? "spawn" : "tell",
    },
  });
}

interface SeedAgentReplyArgs {
  parentToolCallId?: string;
  sequence: number;
  text: string;
  threadId: string;
  turnId: string;
}

function seedAgentReply(
  harness: TestAppHarness,
  args: SeedAgentReplyArgs,
): void {
  const itemId = `item-${args.sequence}`;
  seedStoredEvent(harness.deps, {
    threadId: args.threadId,
    sequence: args.sequence,
    type: "item/completed",
    scope: turnScope(args.turnId),
    itemId,
    itemKind: "agentMessage",
    parentToolCallId: args.parentToolCallId ?? null,
    providerThreadId: "provider-thread",
    data: {
      providerThreadId: "provider-thread",
      item: { type: "agentMessage", id: itemId, text: args.text },
    },
  });
}

function seedTitledThread(harness: TestAppHarness, title: string) {
  const { host } = seedHostSession(harness.deps, { id: "host-title" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/title-regeneration-project",
  });
  return seedThread(harness.deps, { projectId: project.id, title });
}

async function regenerate(harness: TestAppHarness, threadId: string) {
  return harness.app.request(`/api/v1/threads/${threadId}/title/regenerate`, {
    method: "POST",
  });
}

describe("thread title regeneration", () => {
  beforeEach(() => {
    completeTitle.mockReset();
  });

  it("replaces the title using the task, the user's later messages, and the agent's final replies", async () => {
    completeTitle.mockResolvedValue("排查线程标题生成英文的原因");
    await withTitleService(async (harness) => {
      const thread = seedTitledThread(
        harness,
        "Verify BB cloud Chinese support",
      );
      seedTurnRequest(harness, {
        threadId: thread.id,
        sequence: 1,
        initiator: "user",
        target: { kind: "thread-start" },
        input: [
          {
            type: "text",
            text: "Agent-only setup context",
            mentions: [],
            visibility: "agent-only",
          },
          ...textInput("确认一下bb cloud服务是否支持中文"),
        ],
      });
      seedTurnRequest(harness, {
        threadId: thread.id,
        sequence: 2,
        initiator: "agent",
        target: { kind: "new-turn" },
        input: textInput("Message from another thread"),
      });
      seedTurnRequest(harness, {
        threadId: thread.id,
        sequence: 3,
        initiator: "system",
        systemMessageKind: "child-completed",
        target: { kind: "new-turn" },
        input: textInput("A child thread completed"),
      });
      seedTurnRequest(harness, {
        threadId: thread.id,
        sequence: 4,
        initiator: "user",
        target: { kind: "new-turn" },
        input: textInput(
          "请重点检查线程标题为什么生成英文，并验证怎样才能生成中文标题。",
        ),
      });
      seedAgentReply(harness, {
        threadId: thread.id,
        turnId: "turn-1",
        sequence: 5,
        text: "Checking the title prompt",
      });
      seedAgentReply(harness, {
        threadId: thread.id,
        turnId: "turn-1",
        sequence: 6,
        text: "标题提示把语言规则放在了任务前面",
      });
      seedAgentReply(harness, {
        threadId: thread.id,
        turnId: "turn-2",
        sequence: 7,
        text: "Subagent finding",
        parentToolCallId: "tool-call-1",
      });

      const response = await regenerate(harness, thread.id);

      expect(response.status).toBe(200);
      expect(threadSchema.parse(await readJson(response)).title).toBe(
        "排查线程标题生成英文的原因",
      );
      expect(getThread(harness.db, thread.id)?.title).toBe(
        "排查线程标题生成英文的原因",
      );
      const prompt = sentPrompt();
      expect(prompt).toContain("Task:\n确认一下bb cloud服务是否支持中文");
      expect(prompt).toContain(
        "- 请重点检查线程标题为什么生成英文，并验证怎样才能生成中文标题。",
      );
      expect(prompt).toContain("- 标题提示把语言规则放在了任务前面");
      expect(prompt).toContain(
        'The thread is currently titled "Verify BB cloud Chinese support".',
      );
      expect(prompt).not.toContain("Checking the title prompt");
      expect(prompt).not.toContain("Subagent finding");
      expect(prompt).not.toContain("Agent-only setup context");
      expect(prompt).not.toContain("Message from another thread");
      expect(prompt).not.toContain("A child thread completed");
    });
  });

  it("keeps the original task, the latest messages, and the latest replies of a long thread", async () => {
    completeTitle.mockResolvedValue("Ship the release checklist");
    await withTitleService(async (harness) => {
      const thread = seedTitledThread(harness, "Draft the release notes");
      seedTurnRequest(harness, {
        threadId: thread.id,
        sequence: 1,
        initiator: "user",
        target: { kind: "thread-start" },
        input: textInput("Draft the release notes for version two"),
      });
      for (let index = 1; index <= 12; index += 1) {
        seedTurnRequest(harness, {
          threadId: thread.id,
          sequence: index + 1,
          initiator: "user",
          target: { kind: "new-turn" },
          input: textInput(`Follow-up number ${index} for the release`),
        });
      }
      for (let index = 1; index <= 40; index += 1) {
        seedAgentReply(harness, {
          threadId: thread.id,
          turnId: `turn-${index}`,
          sequence: index + 100,
          text: `Reply number ${index} about the release`,
        });
      }

      expect((await regenerate(harness, thread.id)).status).toBe(200);

      const prompt = sentPrompt();
      expect(prompt).toContain(
        "Task:\nDraft the release notes for version two",
      );
      expect(prompt).toContain(
        "- Follow-up number 5 for the release\n- Follow-up number 6",
      );
      expect(prompt).toContain("- Follow-up number 12 for the release");
      expect(prompt).not.toContain("Follow-up number 4 ");
      expect(prompt).toContain(
        "- Reply number 9 about the release\n- Reply number 10",
      );
      expect(prompt).toContain("- Reply number 40 about the release");
      expect(prompt).not.toContain("Reply number 8 ");
    });
  });

  it("leaves the thread untouched when the generated title matches the current one", async () => {
    completeTitle.mockResolvedValue("Investigate the flaky upload test");
    await withTitleService(async (harness) => {
      const thread = seedTitledThread(
        harness,
        "Investigate the flaky upload test",
      );
      harness.db
        .update(threads)
        .set({ updatedAt: 1 })
        .where(eq(threads.id, thread.id))
        .run();
      seedTurnRequest(harness, {
        threadId: thread.id,
        sequence: 1,
        initiator: "user",
        target: { kind: "thread-start" },
        input: textInput("Investigate the flaky upload test in CI"),
      });

      const response = await regenerate(harness, thread.id);

      expect(response.status).toBe(200);
      expect(getThread(harness.db, thread.id)?.updatedAt).toBe(1);
    });
  });

  it.each([
    {
      name: "the title service fails",
      arrange: () => {
        completeTitle.mockRejectedValue(new Error("model overloaded"));
      },
      status: 502,
      message: "model overloaded",
    },
    {
      name: "the title service returns nothing",
      arrange: () => {
        completeTitle.mockResolvedValue("  ");
      },
      status: 502,
      message: "returned an empty",
    },
    {
      name: "thread titles are turned off",
      arrange: (harness: TestAppHarness) => {
        setAiServiceSelection(harness.db, "thread-title", { mode: "off" });
      },
      status: 501,
      message: "Turned off in Settings → AI services",
    },
  ])(
    "keeps the current title and explains why when $name",
    async ({ arrange, status, message }) => {
      await withTitleService(async (harness) => {
        arrange(harness);
        const thread = seedTitledThread(harness, "My chosen title");
        seedTurnRequest(harness, {
          threadId: thread.id,
          sequence: 1,
          initiator: "user",
          target: { kind: "thread-start" },
          input: textInput("Investigate the flaky upload test"),
        });

        const response = await regenerate(harness, thread.id);

        expect(response.status).toBe(status);
        const body = (await readJson(response)) as { message: string };
        expect(body.message).toContain("the current title was kept");
        expect(body.message).toContain(message);
        expect(getThread(harness.db, thread.id)?.title).toBe("My chosen title");
      });
    },
  );

  it("refuses a thread without a task message", async () => {
    await withTitleService(async (harness) => {
      const thread = seedTitledThread(harness, "Empty thread");

      const response = await regenerate(harness, thread.id);

      expect(response.status).toBe(409);
      expect(completeTitle).not.toHaveBeenCalled();
      expect(getThread(harness.db, thread.id)?.title).toBe("Empty thread");
    });
  });
});

describe("thread title regeneration on idle", () => {
  beforeEach(() => {
    completeTitle.mockReset();
  });

  async function setRegenerateTitleOnIdle(
    harness: TestAppHarness,
    enabled: boolean,
  ): Promise<void> {
    const response = await harness.app.request("/api/v1/settings/general", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...defaultAppSettings,
        regenerateTitleOnIdle: enabled,
      }),
    });
    expect(response.status).toBe(200);
  }

  function seedRunningThreads(harness: TestAppHarness, titles: string[]) {
    const { host, session } = seedHostSession(harness.deps, {
      id: "host-idle-title",
    });
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
      path: "/tmp/idle-title-project",
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
    });
    const seeded = titles.map((title, index) => {
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
        title,
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        inputText: `Investigate the flaky upload test number ${index}`,
        providerThreadId: `provider-thread-${index}`,
        threadId: thread.id,
      });
      return { thread, providerThreadId: `provider-thread-${index}` };
    });
    return { sessionId: session.id, threads: seeded };
  }

  async function completeTurn(
    harness: TestAppHarness,
    sessionId: string,
    turnId: string,
    threads: Array<{ thread: { id: string }; providerThreadId: string }>,
  ): Promise<void> {
    const response = await harness.app.request("/internal/session/events", {
      method: "POST",
      headers: internalAuthHeaders(harness),
      body: JSON.stringify({
        sessionId,
        eventGroups: groupHostDaemonEvents(
          threads.flatMap(({ thread, providerThreadId }) => [
            {
              threadId: thread.id,
              event: {
                type: "turn/started" as const,
                threadId: thread.id,
                providerThreadId,
                scope: turnScope(turnId),
              },
            },
            {
              threadId: thread.id,
              event: {
                type: "turn/completed" as const,
                threadId: thread.id,
                providerThreadId,
                scope: turnScope(turnId),
                status: "completed" as const,
              },
            },
          ]),
        ),
      }),
    });
    expect(response.status).toBe(200);
  }

  it("retitles the thread after each completed turn", async () => {
    await withTitleService(async (harness) => {
      await setRegenerateTitleOnIdle(harness, true);
      const { sessionId, threads: seeded } = seedRunningThreads(harness, [
        "Original title",
      ]);
      const [running] = seeded;
      completeTitle.mockResolvedValueOnce("Regenerated by hand");
      expect((await regenerate(harness, running.thread.id)).status).toBe(200);

      completeTitle.mockResolvedValueOnce("Upload test fix");
      await completeTurn(harness, sessionId, "turn-1", seeded);

      await vi.waitFor(() =>
        expect(getThread(harness.db, running.thread.id)?.title).toBe(
          "Upload test fix",
        ),
      );
    });
  });

  it("keeps a title the user renamed by hand while retitling generated ones", async () => {
    await withTitleService(async (harness) => {
      await setRegenerateTitleOnIdle(harness, true);
      const { sessionId, threads: seeded } = seedRunningThreads(harness, [
        "Original title",
        "Other original title",
      ]);
      const [renamed, generated] = seeded;
      completeTitle.mockResolvedValue("Generated title");
      expect((await regenerate(harness, renamed.thread.id)).status).toBe(200);
      expect((await regenerate(harness, generated.thread.id)).status).toBe(200);
      const rename = await harness.app.request(
        `/api/v1/threads/${renamed.thread.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "My own title" }),
        },
      );
      expect(rename.status).toBe(200);
      completeTitle.mockReset();
      completeTitle.mockResolvedValue("Upload test fix");

      await completeTurn(harness, sessionId, "turn-1", seeded);

      await vi.waitFor(() =>
        expect(getThread(harness.db, generated.thread.id)?.title).toBe(
          "Upload test fix",
        ),
      );
      expect(completeTitle).toHaveBeenCalledTimes(1);
      expect(getThread(harness.db, renamed.thread.id)?.title).toBe(
        "My own title",
      );
    });
  });

  it("leaves titles alone when the setting is off", async () => {
    await withTitleService(async (harness) => {
      const { sessionId, threads: seeded } = seedRunningThreads(harness, [
        "Original title",
      ]);
      const [running] = seeded;
      completeTitle.mockResolvedValueOnce("Regenerated by hand");
      expect((await regenerate(harness, running.thread.id)).status).toBe(200);
      completeTitle.mockReset();

      await completeTurn(harness, sessionId, "turn-1", seeded);
      await vi.waitFor(() =>
        expect(getThread(harness.db, running.thread.id)?.status).toBe("idle"),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(completeTitle).not.toHaveBeenCalled();
      expect(getThread(harness.db, running.thread.id)?.title).toBe(
        "Regenerated by hand",
      );
    });
  });
});
