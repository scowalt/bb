import type {
  NewThreadExecutionChoice,
  NewThreadExecutionChooser,
  NewThreadExecutionRequest,
} from "@get-bb/plugin-sdk";
import { validateNewThreadExecutionChoice } from "@get-bb/plugin-sdk/internal/host-policy";
import type { ExecutionInputFieldSource } from "@bb/server-contract";
import type { ThreadCreateServiceRequestInput } from "./thread-create-request.js";
import type { AppDeps } from "../../types.js";
import { errorMessage } from "../lib/error-log-fields.js";
import { pluginExecutionChooserBridge } from "../plugins/plugin-execution-chooser.js";
import { raceTimeout } from "../plugins/plugin-time-box.js";
import { isSelectableProvider } from "./project-execution-defaults.js";
import { resolveSupportedPermissionMode } from "./thread-default-policy.js";
import { providerSupportsReasoningLevel } from "./thread-execution-plan.js";

type ChooserDeps = Pick<AppDeps, "logger" | "providerRegistry">;

type CreateExecutionInputSources = NonNullable<
  ThreadCreateServiceRequestInput["executionInputSources"]
>;
type NamedExecutionField = "providerId" | "model" | "reasoningLevel";

interface NamedExecutionValue<TValue> {
  source: ExecutionInputFieldSource | null;
  value: TValue | null;
}

interface ChooseNewThreadExecutionArgs {
  hostId: string | null;
  input: ThreadCreateServiceRequestInput;
}

function namedExecutionValue<TValue>(
  input: ThreadCreateServiceRequestInput,
  field: NamedExecutionField,
  value: TValue | undefined,
): NamedExecutionValue<TValue> {
  if (value === undefined) {
    return { source: null, value: null };
  }
  const sources = input.executionInputSources;
  if (sources === undefined) {
    return { source: "explicit", value };
  }
  const source = sources[field];
  return source === undefined
    ? { source: null, value: null }
    : { source, value };
}

function buildChooserRequest(
  args: ChooseNewThreadExecutionArgs,
  origin: NewThreadExecutionRequest["origin"],
): NewThreadExecutionRequest {
  const { input } = args;
  const providerId = namedExecutionValue(input, "providerId", input.providerId);
  const model = namedExecutionValue(input, "model", input.model);
  const reasoningLevel = namedExecutionValue(
    input,
    "reasoningLevel",
    input.reasoningLevel,
  );
  return {
    projectId: input.projectId,
    hostId: args.hostId,
    origin,
    originPluginId: input.originPluginId ?? null,
    parentThreadId: input.parentThreadId ?? null,
    requested: {
      providerId: providerId.value,
      model: model.value,
      reasoningLevel: reasoningLevel.value,
    },
    sources: {
      providerId: providerId.source,
      model: model.source,
      reasoningLevel: reasoningLevel.source,
    },
  };
}

async function runWithinTimeBox(
  chooser: NewThreadExecutionChooser,
  request: NewThreadExecutionRequest,
  timeoutMs: number,
): Promise<NewThreadExecutionChoice | null> {
  const controller = new AbortController();
  try {
    return await raceTimeout(
      Promise.resolve().then(() =>
        chooser(request, { signal: controller.signal }),
      ),
      timeoutMs,
      `timed out after ${timeoutMs}ms`,
    );
  } catch (error) {
    controller.abort();
    throw error;
  }
}

async function chooseNewThreadExecution(
  deps: ChooserDeps,
  args: ChooseNewThreadExecutionArgs,
): Promise<NewThreadExecutionChoice | null> {
  const origin = args.input.origin;
  const bridge = pluginExecutionChooserBridge();
  const registration = bridge?.getChooser();
  if (
    origin === null ||
    args.input.originKind != null ||
    bridge === undefined ||
    registration === undefined
  ) {
    return null;
  }
  const request = buildChooserRequest(args, origin);
  const invocation = await bridge.invokeChooser(
    registration,
    "new-thread execution chooser",
    () => runWithinTimeBox(registration.chooser, request, bridge.timeoutMs),
  );
  if (!invocation.ok) {
    deps.logger.warn(
      { pluginId: registration.pluginId, error: invocation.error },
      "The new-thread execution chooser failed; creating the thread without it",
    );
    return null;
  }
  if (invocation.value === null) {
    return null;
  }
  const rejection = (reason: string): null => {
    deps.logger.warn(
      { pluginId: registration.pluginId, reason },
      "The new-thread execution chooser returned an unusable choice; creating the thread without it",
    );
    return null;
  };
  let choice: NewThreadExecutionChoice;
  try {
    choice = validateNewThreadExecutionChoice(invocation.value);
  } catch (error) {
    return rejection(errorMessage(error));
  }
  if (!isSelectableProvider(deps.providerRegistry, choice.providerId)) {
    return rejection(
      `provider "${choice.providerId}" is unknown, disabled, or unavailable`,
    );
  }
  if (
    !providerSupportsReasoningLevel(
      deps.providerRegistry,
      choice.providerId,
      choice.reasoningLevel,
    )
  ) {
    return rejection(
      `provider "${choice.providerId}" does not support the ${choice.reasoningLevel} reasoning level`,
    );
  }
  deps.logger.info(
    {
      pluginId: registration.pluginId,
      projectId: args.input.projectId,
      hostId: args.hostId,
      providerId: choice.providerId,
      model: choice.model,
      reasoningLevel: choice.reasoningLevel,
      reason: choice.reason,
    },
    "Applying the new-thread execution choice",
  );
  return choice;
}

function explicitExecutionSources(
  input: ThreadCreateServiceRequestInput,
): CreateExecutionInputSources {
  if (input.executionInputSources !== undefined) {
    return input.executionInputSources;
  }
  return {
    ...(input.providerId !== undefined ? { providerId: "explicit" } : {}),
    ...(input.model !== undefined ? { model: "explicit" } : {}),
    ...(input.reasoningLevel !== undefined
      ? { reasoningLevel: "explicit" }
      : {}),
    ...(input.serviceTier !== undefined ? { serviceTier: "explicit" } : {}),
    ...(input.permissionMode !== undefined
      ? { permissionMode: "explicit" }
      : {}),
  };
}

function applyNewThreadExecutionChoice(
  deps: Pick<AppDeps, "providerRegistry">,
  input: ThreadCreateServiceRequestInput,
  choice: NewThreadExecutionChoice,
): ThreadCreateServiceRequestInput {
  const requestedProviderId = namedExecutionValue(
    input,
    "providerId",
    input.providerId,
  ).value;
  const requestedModel = namedExecutionValue(input, "model", input.model).value;
  const providerChanged = requestedProviderId !== choice.providerId;
  const moved = providerChanged || requestedModel !== choice.model;
  const { permissionMode, serviceTier, sessionOptions, ...rest } = input;
  return {
    ...rest,
    ...(moved || serviceTier === undefined ? {} : { serviceTier }),
    ...(moved || sessionOptions === undefined ? {} : { sessionOptions }),
    ...(permissionMode === undefined
      ? {}
      : {
          permissionMode: providerChanged
            ? resolveSupportedPermissionMode(deps.providerRegistry, {
                preferredPermissionMode: permissionMode,
                providerId: choice.providerId,
              })
            : permissionMode,
        }),
    providerId: choice.providerId,
    model: choice.model,
    reasoningLevel: choice.reasoningLevel,
    executionInputSources: {
      ...explicitExecutionSources(input),
      providerId: "explicit",
      model: "explicit",
      reasoningLevel: "explicit",
    },
  };
}

export async function resolveThreadCreateExecutionInput(
  deps: ChooserDeps,
  args: ChooseNewThreadExecutionArgs,
): Promise<ThreadCreateServiceRequestInput> {
  const choice = await chooseNewThreadExecution(deps, args);
  return choice === null
    ? args.input
    : applyNewThreadExecutionChoice(deps, args.input, choice);
}
