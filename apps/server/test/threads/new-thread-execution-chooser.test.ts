import { getProjectExecutionDefaults, setDisabledProviderIds } from "@bb/db";
import type {
  NewThreadExecutionChoice,
  NewThreadExecutionChooser,
  NewThreadExecutionRequest,
} from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  invokePluginInline,
  type PluginHookInvocation,
} from "../../src/services/plugins/plugin-hook-registry.js";
import { setPluginExecutionChooserBridge } from "../../src/services/plugins/plugin-execution-chooser.js";
import type { ThreadCreateServiceRequestInput } from "../../src/services/threads/thread-create-request.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { availableModelFixture } from "../helpers/available-models.js";
import { waitForQueuedCommand } from "../helpers/commands.js";
import { installFakeGitWorktreeProvider } from "../helpers/environment-provider.js";
import { textInput } from "../helpers/prompt-input.js";
import { seedModelCatalog } from "../helpers/provider-model-catalogs.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadIdentity,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const OPUS = "claude-bridge/claude-opus-5-5";

const OPUS_CHOICE: NewThreadExecutionChoice = {
  providerId: "pi",
  model: OPUS,
  reasoningLevel: "xhigh",
  reason: "Opus has the lower weekly pace",
};

afterEach(() => {
  setPluginExecutionChooserBridge(undefined);
});

function installChooser(
  chooser: NewThreadExecutionChooser,
  options: { timeoutMs?: number } = {},
): void {
  setPluginExecutionChooserBridge({
    getChooser: () => ({ pluginId: "usage-pace", chooser }),
    invokeChooser: <T>(
      _registration: unknown,
      _label: string,
      run: () => Promise<T>,
    ): Promise<PluginHookInvocation<T>> => invokePluginInline(run),
    timeoutMs: options.timeoutMs ?? 3_000,
  });
}

function recordingChooser(answer: () => ReturnType<NewThreadExecutionChooser>) {
  const requests: NewThreadExecutionRequest[] = [];
  const chooser: NewThreadExecutionChooser = (request) => {
    requests.push(request);
    return answer();
  };
  return { chooser, requests };
}

async function seedWorkspace(harness: TestAppHarness, name: string) {
  const { host } = seedHostSession(harness.deps, { id: `host-${name}` });
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/${name}-workspace`,
  });
  for (const [providerId, model] of [
    ["codex", "gpt-5"],
    ["codex", "gpt-5-mini"],
    ["pi", OPUS],
  ] as const) {
    await seedModelCatalog(harness, {
      hostId: host.id,
      providerId,
      models: [availableModelFixture({ model })],
    });
  }
  return { environment, host, project };
}

type CreateOverrides = Partial<
  Omit<ThreadCreateServiceRequestInput, "environment" | "projectId">
>;

async function createAndStart(
  harness: TestAppHarness,
  fixture: Awaited<ReturnType<typeof seedWorkspace>>,
  overrides: CreateOverrides,
) {
  const thread = await createThreadFromRequest(harness.deps, {
    projectId: fixture.project.id,
    environment: { type: "reuse", environmentId: fixture.environment.id },
    input: textInput("Pick my model"),
    origin: "app",
    startedOnBehalfOf: null,
    ...overrides,
  });
  const start = await waitForQueuedCommand(
    harness,
    ({ command }) =>
      command.type === "thread.start" && command.threadId === thread.id,
  );
  if (start.command.type !== "thread.start") {
    throw new Error("Expected a thread start command");
  }
  return { options: start.command.options, thread };
}

const composerThread: CreateOverrides = {
  providerId: "codex",
  model: "gpt-5",
  reasoningLevel: "low",
  executionInputSources: {
    providerId: "client-preference",
    model: "client-preference",
    reasoningLevel: "client-preference",
  },
};

const codexOptions: CreateOverrides = {
  ...composerThread,
  permissionMode: "accept-edits",
  serviceTier: "fast",
  sessionOptions: { daybreak: true },
  executionInputSources: {
    providerId: "client-preference",
    model: "client-preference",
    reasoningLevel: "client-preference",
    permissionMode: "explicit",
    serviceTier: "explicit",
  },
};

describe("the new-thread execution chooser at thread create", () => {
  it("starts a composer thread on the provider, model, and reasoning level the chooser picked", async () => {
    await withTestHarness(async (harness) => {
      const fixture = await seedWorkspace(harness, "chooser-lands");
      const { chooser, requests } = recordingChooser(() => OPUS_CHOICE);
      installChooser(chooser);

      const { options, thread } = await createAndStart(
        harness,
        fixture,
        composerThread,
      );

      expect(thread.providerId).toBe("pi");
      expect(options.model).toBe(OPUS);
      expect(options.reasoningLevel).toBe("xhigh");
      expect(requests).toEqual([
        {
          projectId: fixture.project.id,
          hostId: fixture.host.id,
          origin: "app",
          originPluginId: null,
          parentThreadId: null,
          requested: {
            providerId: "codex",
            model: "gpt-5",
            reasoningLevel: "low",
          },
          sources: {
            providerId: "client-preference",
            model: "client-preference",
            reasoningLevel: "client-preference",
          },
        },
      ]);
    });
  });

  it("tells the chooser what a spawn named and where each value came from", async () => {
    await withTestHarness(async (harness) => {
      const fixture = await seedWorkspace(harness, "chooser-request");
      const parent = seedThread(harness.deps, {
        projectId: fixture.project.id,
        environmentId: fixture.environment.id,
      });
      const { chooser, requests } = recordingChooser(() => null);
      installChooser(chooser);

      await createAndStart(harness, fixture, {
        origin: "plugin",
        originPluginId: "magic-compose",
        parentThreadId: parent.id,
        model: "gpt-5",
      });
      await createAndStart(harness, fixture, {
        origin: "cli",
        providerId: "codex",
        executionInputSources: { model: "explicit" },
        model: "gpt-5-mini",
      });

      expect(requests.map(({ requested, sources, ...rest }) => rest)).toEqual([
        {
          projectId: fixture.project.id,
          hostId: fixture.host.id,
          origin: "plugin",
          originPluginId: "magic-compose",
          parentThreadId: parent.id,
        },
        {
          projectId: fixture.project.id,
          hostId: fixture.host.id,
          origin: "cli",
          originPluginId: null,
          parentThreadId: null,
        },
      ]);
      expect(requests.map(({ requested }) => requested)).toEqual([
        { providerId: null, model: "gpt-5", reasoningLevel: null },
        { providerId: null, model: "gpt-5-mini", reasoningLevel: null },
      ]);
      expect(requests.map(({ sources }) => sources)).toEqual([
        { providerId: null, model: "explicit", reasoningLevel: null },
        { providerId: null, model: "explicit", reasoningLevel: null },
      ]);
    });
  });

  describe.each([
    {
      name: "answers null",
      install: () => installChooser(() => null),
    },
    {
      name: "throws",
      install: () =>
        installChooser(() => {
          throw new Error("usage cache unreadable");
        }),
    },
    {
      name: "rejects",
      install: () =>
        installChooser(() => Promise.reject(new Error("usage cache offline"))),
    },
    {
      name: "answers with a choice that has no model",
      install: () =>
        installChooser(
          () =>
            ({ ...OPUS_CHOICE, model: "" }) satisfies NewThreadExecutionChoice,
        ),
    },
    {
      name: "picks a provider that does not exist",
      install: () =>
        installChooser(() => ({ ...OPUS_CHOICE, providerId: "no-such-agent" })),
    },
    {
      name: "picks a reasoning level its provider lacks",
      install: () =>
        installChooser(() => ({ ...OPUS_CHOICE, reasoningLevel: "ultra" })),
    },
    {
      name: "picks a provider the user disabled",
      install: (harness: TestAppHarness) => {
        setDisabledProviderIds(harness.db, ["pi"]);
        installChooser(() => OPUS_CHOICE);
      },
    },
  ])("when the chooser $name", ({ install }) => {
    it("creates the thread exactly as it would without a chooser", async () => {
      await withTestHarness(async (harness) => {
        const fixture = await seedWorkspace(harness, "chooser-fail-open");
        install(harness);

        const { options, thread } = await createAndStart(
          harness,
          fixture,
          composerThread,
        );

        expect(thread.providerId).toBe("codex");
        expect(options.model).toBe("gpt-5");
        expect(options.reasoningLevel).toBe("low");
      });
    });
  });

  it("creates the thread as it would without a chooser when the chooser outlasts its time box", async () => {
    await withTestHarness(async (harness) => {
      const fixture = await seedWorkspace(harness, "chooser-slow");
      const aborted: boolean[] = [];
      installChooser(
        (_request, { signal }) =>
          new Promise<NewThreadExecutionChoice>((resolve) => {
            setTimeout(() => {
              aborted.push(signal.aborted);
              resolve(OPUS_CHOICE);
            }, 150);
          }),
        { timeoutMs: 20 },
      );

      const { options, thread } = await createAndStart(
        harness,
        fixture,
        composerThread,
      );

      expect(thread.providerId).toBe("codex");
      expect(options.model).toBe("gpt-5");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(aborted).toEqual([true]);
    });
  });

  it("does not ask the chooser about a fork, which keeps its source's provider", async () => {
    await withTestHarness(async (harness) => {
      installFakeGitWorktreeProvider();
      const { host } = seedHostSession(harness.deps, {
        id: "host-chooser-fork",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const sourceEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/chooser-fork-source",
      });
      const source = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: sourceEnvironment.id,
      });
      seedThreadIdentity(harness.deps, {
        threadId: source.id,
        providerThreadId: "provider-chooser-fork-source",
      });
      seedTurnStarted(harness.deps, {
        threadId: source.id,
        turnId: "turn-chooser-fork-source",
        providerThreadId: "provider-chooser-fork-source",
      });
      await seedModelCatalog(harness, {
        hostId: host.id,
        providerId: "codex",
        models: [availableModelFixture({ model: "gpt-5" })],
      });
      const { chooser, requests } = recordingChooser(() => OPUS_CHOICE);
      installChooser(chooser);

      const fork = await createThreadFromRequest(harness.deps, {
        origin: "app",
        originKind: "fork",
        startedOnBehalfOf: null,
        parentThreadId: source.id,
        projectId: project.id,
        providerId: "codex",
        model: "gpt-5",
        reasoningLevel: "high",
        input: textInput("Quick question"),
        environment: {
          type: "host",
          hostId: host.id,
          workspace: { type: "unmanaged", path: null },
        },
      });

      expect(requests).toEqual([]);
      expect(fork.providerId).toBe("codex");
    });
  });

  describe("when the choice moves the thread to another provider", () => {
    it("lowers a permission mode the new provider lacks and drops the session options and service tier", async () => {
      await withTestHarness(async (harness) => {
        const fixture = await seedWorkspace(harness, "chooser-switch");
        installChooser(() => OPUS_CHOICE);

        const { options, thread } = await createAndStart(
          harness,
          fixture,
          codexOptions,
        );

        expect(thread.providerId).toBe("pi");
        expect(options.permissionMode).toBe("full");
        expect(options.serviceTier).toBe("default");
        expect(options).not.toHaveProperty("sessionOptions");
      });
    });

    it("does the same when the request named no provider or model", async () => {
      await withTestHarness(async (harness) => {
        const fixture = await seedWorkspace(harness, "chooser-named-nothing");
        installChooser(() => OPUS_CHOICE);

        const { options, thread } = await createAndStart(harness, fixture, {
          origin: "cli",
          permissionMode: "accept-edits",
          serviceTier: "fast",
          sessionOptions: { daybreak: true },
        });

        expect(thread.providerId).toBe("pi");
        expect(options.model).toBe(OPUS);
        expect(options.permissionMode).toBe("full");
        expect(options.serviceTier).toBe("default");
        expect(options).not.toHaveProperty("sessionOptions");
      });
    });
  });

  describe("when the choice keeps the provider", () => {
    it("keeps the request's permission mode, service tier, and session options when it confirms the model too", async () => {
      await withTestHarness(async (harness) => {
        const fixture = await seedWorkspace(harness, "chooser-confirms");
        installChooser(() => ({
          providerId: "codex",
          model: "gpt-5",
          reasoningLevel: "high",
          reason: "Codex stays on its model",
        }));

        const { options, thread } = await createAndStart(
          harness,
          fixture,
          codexOptions,
        );

        expect(thread.providerId).toBe("codex");
        expect(options.reasoningLevel).toBe("high");
        expect(options.permissionMode).toBe("accept-edits");
        expect(options.serviceTier).toBe("fast");
        expect(options.sessionOptions).toEqual({ daybreak: true });
      });
    });

    it("drops the session options and service tier when it picks another model, which they were not chosen for", async () => {
      await withTestHarness(async (harness) => {
        const fixture = await seedWorkspace(harness, "chooser-other-model");
        installChooser(() => ({
          providerId: "codex",
          model: "gpt-5-mini",
          reasoningLevel: "medium",
          reason: "The mini model has the lower pace",
        }));

        const { options, thread } = await createAndStart(
          harness,
          fixture,
          codexOptions,
        );

        expect(thread.providerId).toBe("codex");
        expect(options.model).toBe("gpt-5-mini");
        expect(options.permissionMode).toBe("accept-edits");
        expect(options.serviceTier).toBe("default");
        expect(options).not.toHaveProperty("sessionOptions");
      });
    });
  });

  it("starts a composer thread that named a provider but no model, as a hidden model picker sends it", async () => {
    await withTestHarness(async (harness) => {
      const fixture = await seedWorkspace(harness, "chooser-no-model");

      const { options, thread } = await createAndStart(harness, fixture, {
        providerId: "codex",
        reasoningLevel: "low",
        executionInputSources: {
          providerId: "client-preference",
          reasoningLevel: "client-preference",
        },
      });

      expect(thread.providerId).toBe("codex");
      expect(options.model).toEqual(expect.any(String));
    });
  });

  describe("the project's remembered execution defaults", () => {
    async function createInNewEnvironment(
      harness: TestAppHarness,
      fixture: Awaited<ReturnType<typeof seedWorkspace>>,
    ) {
      await createThreadFromRequest(harness.deps, {
        projectId: fixture.project.id,
        environment: {
          type: "host",
          hostId: fixture.host.id,
          workspace: { type: "unmanaged", path: null },
        },
        input: textInput("Pick my model"),
        origin: "app",
        startedOnBehalfOf: null,
        ...composerThread,
      });
      return getProjectExecutionDefaults(harness.deps.db, {
        projectId: fixture.project.id,
      });
    }

    it("remembers what a composer thread picked when no chooser is registered", async () => {
      await withTestHarness(async (harness) => {
        const fixture = await seedWorkspace(harness, "chooser-remember-none");

        const defaults = await createInNewEnvironment(harness, fixture);

        expect(defaults?.providerId).toBe("codex");
        expect(defaults?.model).toBe("gpt-5");
      });
    });

    it("does not remember the chooser's choice, so the next composer starts from what a person picked", async () => {
      await withTestHarness(async (harness) => {
        const fixture = await seedWorkspace(harness, "chooser-remember-chosen");
        installChooser(() => OPUS_CHOICE);

        const defaults = await createInNewEnvironment(harness, fixture);

        expect(defaults).toBeNull();
      });
    });

    it("keeps an earlier remembered default when the chooser picks another provider", async () => {
      await withTestHarness(async (harness) => {
        const fixture = await seedWorkspace(harness, "chooser-remember-kept");
        const first = await createInNewEnvironment(harness, fixture);
        installChooser(() => OPUS_CHOICE);

        const second = await createInNewEnvironment(harness, fixture);

        expect(first?.providerId).toBe("codex");
        expect(second).toEqual(first);
      });
    });
  });
});
