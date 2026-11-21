import type { NewThreadExecutionChooser } from "@get-bb/plugin-sdk";
import type { PluginHookInvocation } from "./plugin-hook-registry.js";

export interface PluginExecutionChooserRegistration {
  pluginId: string;
  chooser: NewThreadExecutionChooser;
}

export interface PluginExecutionChooserBridge {
  getChooser(): PluginExecutionChooserRegistration | undefined;
  invokeChooser<T>(
    registration: PluginExecutionChooserRegistration,
    label: string,
    run: () => Promise<T>,
  ): Promise<PluginHookInvocation<T>>;
}

let bridge: PluginExecutionChooserBridge | undefined;

export function setPluginExecutionChooserBridge(
  next: PluginExecutionChooserBridge | undefined,
): void {
  bridge = next;
}

export function pluginExecutionChooserBridge():
  | PluginExecutionChooserBridge
  | undefined {
  return bridge;
}
