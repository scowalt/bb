import { createHash } from "node:crypto";
import type { BbDesktopServerChoice } from "@bb/desktop-contract";
import {
  BUILTIN_SERVER_NAME,
  type ConnectServerRef,
  type CustomServer,
  type DesktopServerTarget,
} from "./server-target.js";

export interface ServerNames {
  customServers: readonly CustomServer[];
  getConnectServerName(handle: string): string | null;
}

interface ListDesktopServerTargetsArgs {
  activeTarget: DesktopServerTarget | null;
  connectServers: readonly ConnectServerRef[];
  customServers: readonly CustomServer[];
  showBuiltinServer: boolean;
}

interface BuildDesktopServerChoicesArgs
  extends ListDesktopServerTargetsArgs, ServerNames {}

export function customServerId(url: string): string {
  return `custom:${createHash("sha256").update(url).digest("hex")}`;
}

export function serverTargetId(target: DesktopServerTarget): string {
  if (target.kind === "connect") {
    return `connect:${target.server.handle}`;
  }
  if (target.kind === "custom") {
    return customServerId(target.url);
  }
  return "builtin";
}

export function serverTargetName(
  target: DesktopServerTarget,
  names: ServerNames,
): string {
  if (target.kind === "connect") {
    return (
      names.getConnectServerName(target.server.handle) ??
      new URL(target.server.url).host
    );
  }
  if (target.kind === "custom") {
    return (
      names.customServers.find((server) => server.url === target.url)?.name ??
      new URL(target.url).host
    );
  }
  return BUILTIN_SERVER_NAME;
}

export function listDesktopServerTargets(
  args: ListDesktopServerTargetsArgs,
): DesktopServerTarget[] {
  const showBuiltin =
    args.showBuiltinServer ||
    args.activeTarget?.kind === "builtin" ||
    (args.connectServers.length === 0 && args.customServers.length === 0);
  return [
    ...(showBuiltin ? [{ kind: "builtin" } as const] : []),
    ...args.connectServers.map((server): DesktopServerTarget => ({
      kind: "connect",
      server: { ...server },
    })),
    ...args.customServers.map(({ url }): DesktopServerTarget => ({
      kind: "custom",
      url,
    })),
  ];
}

export function buildDesktopServerChoices(
  args: BuildDesktopServerChoicesArgs,
): BbDesktopServerChoice[] {
  const activeId =
    args.activeTarget === null ? null : serverTargetId(args.activeTarget);
  return listDesktopServerTargets(args).map((target) => {
    const id = serverTargetId(target);
    return {
      id,
      name: serverTargetName(target, args),
      active: id === activeId,
    };
  });
}
