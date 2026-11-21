// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings } from "@bb/domain";
import { systemConfigQueryKey } from "@/hooks/queries/query-keys";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  ExecutionControls,
  type ExecutionControlsProps,
} from "./ExecutionControls";
import { ModelReasoningMenu } from "@/components/pickers/ModelReasoningMenuSplit";

function makeExecutionControlsProps(
  providerOnChange?: (value: string) => void,
): ExecutionControlsProps {
  return {
    provider: {
      options: [
        { value: "codex", label: "Codex" },
        { value: "claude", label: "Claude Code" },
      ],
      selectedId: "codex",
      onChange: providerOnChange,
      hasMultiple: true,
    },
    model: {
      active: null,
      selected: "gpt-5",
      options: [{ value: "gpt-5", label: "GPT-5" }],
      moreOptions: [],
      isLoading: false,
      loadFailed: false,
      loadError: null,
      onChange: vi.fn(),
    },
    reasoning: {
      value: "medium",
      options: [{ value: "medium", label: "Medium" }],
      isLoading: false,
      onChange: vi.fn(),
    },
  };
}

function renderExecutionControls(
  props: ExecutionControlsProps,
  options: { hideModelPicker?: boolean } = {},
) {
  const { queryClient, wrapper } = createQueryClientTestHarness();
  if (options.hideModelPicker !== undefined) {
    queryClient.setQueryData(systemConfigQueryKey(), {
      generalSettings: {
        ...defaultAppSettings,
        hideModelPicker: options.hideModelPicker,
      },
    });
  }
  return render(<ExecutionControls {...props} />, { wrapper });
}

await ModelReasoningMenu.preload();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ExecutionControls", () => {
  it("hides provider tabs when the provider is locked", () => {
    renderExecutionControls(makeExecutionControlsProps());

    fireEvent.click(
      screen.getByRole("button", {
        name: "Provider, model and reasoning",
      }),
    );

    expect(screen.queryByText("Model")).not.toBeNull();
    expect(screen.queryByTitle("Claude Code")).toBeNull();
  });

  it("shows provider tabs when provider changes are allowed", () => {
    renderExecutionControls(makeExecutionControlsProps(vi.fn()));

    fireEvent.click(
      screen.getByRole("button", {
        name: "Provider, model and reasoning",
      }),
    );

    expect(screen.queryByTitle("Claude Code")).not.toBeNull();
  });

  it("hides the whole picker when the hide-the-model-picker setting is on", () => {
    renderExecutionControls(makeExecutionControlsProps(vi.fn()), {
      hideModelPicker: true,
    });

    expect(
      screen.queryByRole("button", { name: "Provider, model and reasoning" }),
    ).toBeNull();
  });

  it("shows the picker when the hide-the-model-picker setting is off", () => {
    renderExecutionControls(makeExecutionControlsProps(vi.fn()), {
      hideModelPicker: false,
    });

    expect(
      screen.queryByRole("button", { name: "Provider, model and reasoning" }),
    ).not.toBeNull();
  });

  it("keeps showing the known model when model options fail to load", () => {
    const props = makeExecutionControlsProps();
    renderExecutionControls({
      ...props,
      model: {
        ...props.model,
        active: { model: "o4-mini" },
        options: [],
        loadFailed: true,
        loadError: { providerId: "codex", code: "failed", detail: null },
      },
    });

    const trigger = screen.getByRole("button", {
      name: "Provider, model and reasoning",
    });

    expect(trigger.textContent).toContain("o4-mini");
    expect(trigger.textContent).not.toContain("Failed to load models");
  });
});
