import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbConnection } from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import type { Logger } from "@bb/logger";
import type { NewThreadExecutionRequest } from "@get-bb/plugin-sdk";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";
import { testLogger } from "../../helpers/test-app.js";

const logger = testLogger as unknown as Logger;

const REQUEST: NewThreadExecutionRequest = {
  projectId: "project-1",
  hostId: "host-1",
  origin: "app",
  originPluginId: null,
  parentThreadId: null,
  requested: { providerId: null, model: null, reasoningLevel: null },
  sources: { providerId: null, model: null, reasoningLevel: null },
};

async function writePlugin(
  dir: string,
  options: { name: string; serverSource: string },
): Promise<string> {
  const rootDir = join(dir, options.name);
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: options.name,
      version: "0.1.0",
      bb: {
        name: "Execution chooser fixture",
        description: "Execution chooser plugin fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), options.serverSource);
  return rootDir;
}

function chooserSource(reason: string): string {
  return `
    export default function plugin(bb: any) {
      bb.providers.experimental_chooseNewThreadExecution(() => ({
        providerId: "pi",
        model: "model-from-${reason}",
        reasoningLevel: "high",
        reason: "${reason}",
      }));
    }
  `;
}

async function askChooser(service: PluginService) {
  const registration = service.executionChooser.getChooser();
  if (registration === undefined) return undefined;
  const outcome = await service.executionChooser.invokeChooser(
    registration,
    "new-thread execution chooser",
    async () =>
      registration.chooser(REQUEST, { signal: new AbortController().signal }),
  );
  return { pluginId: registration.pluginId, outcome };
}

describe("bb.providers.experimental_chooseNewThreadExecution", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService;

  beforeEach(async () => {
    db = createMigratedConnection();
    workDir = await mkdtemp(join(tmpdir(), "bb-plugin-chooser-test-"));
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginChanged: () => {},
        onWatchedTargets: () => () => {},
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(workDir, "data"),
      appVersion: "0.9.0",
      loadTimeoutMs: 2000,
    });
  });

  afterEach(async () => {
    await service.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  it("answers a thread create with the registering plugin's choice", async () => {
    const entry = await service.installPath(
      await writePlugin(workDir, {
        name: "bb-plugin-chooser-a",
        serverSource: chooserSource("first"),
      }),
    );
    expect(entry.status).toBe("running");

    expect(await askChooser(service)).toEqual({
      pluginId: "chooser-a",
      outcome: {
        ok: true,
        value: {
          providerId: "pi",
          model: "model-from-first",
          reasoningLevel: "high",
          reason: "first",
        },
      },
    });
  });

  it("refuses a second plugin's chooser, naming the plugin that holds it", async () => {
    await service.installPath(
      await writePlugin(workDir, {
        name: "bb-plugin-chooser-a",
        serverSource: chooserSource("first"),
      }),
    );
    const second = await service.installPath(
      await writePlugin(workDir, {
        name: "bb-plugin-chooser-b",
        serverSource: chooserSource("second"),
      }),
    );

    expect(second.status).toBe("error");
    expect(second.statusDetail).toContain(
      'a new-thread execution chooser is already registered by plugin "chooser-a"',
    );
    expect((await askChooser(service))?.pluginId).toBe("chooser-a");
  });

  it("refuses a second chooser from the same plugin", async () => {
    const entry = await service.installPath(
      await writePlugin(workDir, {
        name: "bb-plugin-chooser-twice",
        serverSource: `
          export default function plugin(bb: any) {
            bb.providers.experimental_chooseNewThreadExecution(() => null);
            bb.providers.experimental_chooseNewThreadExecution(() => null);
          }
        `,
      }),
    );

    expect(entry.status).toBe("error");
    expect(entry.statusDetail).toContain(
      "a new-thread execution chooser is already registered by this plugin",
    );
    expect(service.executionChooser.getChooser()).toBeUndefined();
  });

  it("refuses a chooser that is not a function", async () => {
    const entry = await service.installPath(
      await writePlugin(workDir, {
        name: "bb-plugin-chooser-bad",
        serverSource: `
          export default function plugin(bb: any) {
            bb.providers.experimental_chooseNewThreadExecution("pi");
          }
        `,
      }),
    );

    expect(entry.status).toBe("error");
    expect(entry.statusDetail).toContain(
      "chooseNewThreadExecution requires a chooser function",
    );
    expect(service.executionChooser.getChooser()).toBeUndefined();
  });

  it("drops the chooser when its plugin is disabled, so another plugin can register one", async () => {
    await service.installPath(
      await writePlugin(workDir, {
        name: "bb-plugin-chooser-a",
        serverSource: chooserSource("first"),
      }),
    );
    expect(service.executionChooser.getChooser()?.pluginId).toBe("chooser-a");

    await service.setEnabled("chooser-a", false);
    expect(service.executionChooser.getChooser()).toBeUndefined();

    const second = await service.installPath(
      await writePlugin(workDir, {
        name: "bb-plugin-chooser-b",
        serverSource: chooserSource("second"),
      }),
    );
    expect(second.status).toBe("running");
    expect((await askChooser(service))?.pluginId).toBe("chooser-b");
  });
});
