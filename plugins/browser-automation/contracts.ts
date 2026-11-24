import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const idSchema = z.string().min(1).max(160);
export const sessionIdSchema = z.string().uuid();
export const profileSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
export const DEFAULT_PROFILE = "default";
export const sessionSchema = z
  .object({
    id: sessionIdSchema,
    threadId: idSchema,
    hostId: idSchema,
    backend: z.enum(["desktop", "local"]),
    profile: profileSchema.nullable(),
    state: z.enum(["ready", "stopped", "closed"]),
    createdAt: z.number().int(),
    expiresAt: z.number().int(),
  })
  .strict();
export type Session = z.infer<typeof sessionSchema>;
export const selectionSchema = z.discriminatedUnion("backend", [
  z
    .object({
      backend: z.literal("local"),
      hostId: idSchema,
      profile: profileSchema.optional(),
    })
    .strict(),
  z
    .object({
      backend: z.literal("desktop"),
      hostId: idSchema,
      instanceId: idSchema,
      tabId: idSchema.optional(),
    })
    .strict(),
]);
export const openSchema = z
  .object({ threadId: idSchema, selection: selectionSchema })
  .strict();
export const ownedSchema = z
  .object({ threadId: idSchema, sessionId: sessionIdSchema })
  .strict();
export const runSchema = ownedSchema.extend({
  script: z.string().min(1).max(128_000),
  timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
});
export const screenshotSchema = ownedSchema.extend({
  page: z.string().min(1).max(120).default("main"),
});
export const imageSchema = z
  .object({
    path: z.string().min(1),
    mimeType: z.literal("image/jpeg"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
export const outputSchema = z
  .object({
    text: z.string().max(160_000),
    images: z.array(imageSchema).max(4),
    exitCode: z.number().int(),
  })
  .strict();
export type RunOutput = z.infer<typeof outputSchema>;
const pointSchema = {
  x: z.number().min(0).max(10_000),
  y: z.number().min(0).max(10_000),
};
const modifiersSchema = z.number().int().min(0).max(15);
const browsableUrlSchema = z
  .string()
  .max(2_000)
  .url()
  .refine((url) => /^(https?:|about:)/i.test(url), {
    message: "Only http, https and about URLs can be opened",
  });
export const viewerActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("mouse"),
      event: z.enum(["move", "down", "up"]),
      ...pointSchema,
      button: z.enum(["none", "left", "middle", "right"]),
      clickCount: z.number().int().min(0).max(3),
      modifiers: modifiersSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("wheel"),
      ...pointSchema,
      deltaX: z.number().min(-10_000).max(10_000),
      deltaY: z.number().min(-10_000).max(10_000),
      modifiers: modifiersSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("key"),
      event: z.enum(["down", "up"]),
      key: z.string().min(1).max(40),
      code: z.string().max(40),
      text: z.string().min(1).max(8).optional(),
      keyCode: z.number().int().min(0).max(255),
      modifiers: modifiersSchema,
    })
    .strict(),
  z
    .object({ type: z.literal("text"), text: z.string().min(1).max(10_000) })
    .strict(),
  z.object({ type: z.literal("navigate"), url: browsableUrlSchema }).strict(),
  z
    .object({
      type: z.literal("history"),
      delta: z.union([z.literal(-1), z.literal(1)]),
    })
    .strict(),
  z.object({ type: z.literal("reload") }).strict(),
  z
    .object({
      type: z.literal("resize"),
      width: z.number().int().min(320).max(2_560),
      height: z.number().int().min(240).max(2_560),
    })
    .strict(),
  z.object({ type: z.literal("selectTab"), tabId: idSchema }).strict(),
  z
    .object({ type: z.literal("newTab"), url: browsableUrlSchema.optional() })
    .strict(),
  z.object({ type: z.literal("closeTab"), tabId: idSchema }).strict(),
]);
export type ViewerAction = z.infer<typeof viewerActionSchema>;
export const viewerActionsSchema = z.array(viewerActionSchema).min(1).max(64);
export const inputSchema = ownedSchema.extend({ actions: viewerActionsSchema });
export const previewTabSchema = z
  .object({
    id: idSchema,
    title: z.string().max(300),
    url: z.string().max(2_000),
  })
  .strict();
export type PreviewTab = z.infer<typeof previewTabSchema>;
export const previewFrameSchema = z
  .object({
    sequence: z.number().int().positive(),
    mimeType: z.literal("image/jpeg"),
    data: z.string().min(1).max(700_000),
    width: z.number().positive(),
    height: z.number().positive(),
    url: z.string().max(2_000),
    title: z.string().max(300),
    tabs: z.array(previewTabSchema).max(20),
    activeTabId: idSchema,
  })
  .strict();
export type PreviewFrame = z.infer<typeof previewFrameSchema>;
export const previewSizeSchema = z.enum(["thumbnail", "full"]);
export type PreviewSize = z.infer<typeof previewSizeSchema>;
export const previewSchema = ownedSchema.extend({
  afterSequence: z.number().int().nonnegative().default(0),
  size: previewSizeSchema.default("thumbnail"),
});
export const previewOutputSchema = z
  .object({ session: sessionSchema, frame: previewFrameSchema.nullable() })
  .strict();
export type PreviewOutput = z.infer<typeof previewOutputSchema>;
export const rpcContract = defineRpcContract({
  open: { input: openSchema, output: sessionSchema },
  list: {
    input: z.object({ threadId: idSchema }).strict(),
    output: z.array(sessionSchema).max(64),
  },
  run: { input: runSchema, output: outputSchema },
  pages: { input: ownedSchema, output: outputSchema },
  screenshot: { input: screenshotSchema, output: outputSchema },
  preview: { input: previewSchema, output: previewOutputSchema },
  input: { input: inputSchema, output: z.null() },
  openForThread: {
    input: z.object({ threadId: idSchema }).strict(),
    output: sessionSchema,
  },
  stop: { input: ownedSchema, output: sessionSchema },
  close: { input: ownedSchema, output: sessionSchema },
});
export const runtimeStateSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      version: z.string(),
      source: z.enum(["release", "developer-artifact"]),
    })
    .strict(),
  z.object({ status: z.literal("installing"), detail: z.string() }).strict(),
]);
export type RuntimeState = z.infer<typeof runtimeStateSchema>;
export const hostContract = defineRpcContract({
  prepare: { input: z.object({}).strict(), output: runtimeStateSchema },
  open: {
    input: z
      .object({
        sessionId: sessionIdSchema,
        connectionUrl: z.string().url().optional(),
        profile: profileSchema.optional(),
        expiresAt: z.number().int(),
        idleTimeoutMs: z.number().int().positive(),
      })
      .strict(),
    output: z.null(),
  },
  run: {
    input: z
      .object({
        sessionId: sessionIdSchema,
        script: z.string().min(1).max(128_000),
        timeoutMs: z.number().int().min(1000).max(120_000),
      })
      .strict(),
    output: outputSchema,
  },
  preview: {
    input: z
      .object({
        sessionId: sessionIdSchema,
        afterSequence: z.number().int().nonnegative(),
        waitMs: z.number().int().min(0).max(10_000),
        size: previewSizeSchema,
      })
      .strict(),
    output: z.object({ frame: previewFrameSchema.nullable() }).strict(),
  },
  input: {
    input: z
      .object({ sessionId: sessionIdSchema, actions: viewerActionsSchema })
      .strict(),
    output: z.null(),
  },
  close: {
    input: z.object({ sessionId: sessionIdSchema }).strict(),
    output: z.null(),
  },
});
