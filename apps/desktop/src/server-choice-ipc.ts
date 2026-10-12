import {
  bbDesktopConnectSignInLabel,
  bbDesktopServerChoiceSchema,
  type BbDesktopServerList,
} from "@bb/desktop-contract";
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import {
  BB_DESKTOP_ADD_SERVER_CHANNEL,
  BB_DESKTOP_GET_SERVER_CHOICES_CHANNEL,
  BB_DESKTOP_SELECT_SERVER_CHANNEL,
  BB_DESKTOP_SIGN_IN_TO_CONNECT_CHANNEL,
} from "./desktop-window-command-ipc.js";

export function registerServerChoiceIpc({
  applicationWindowWebContentsIds,
  onListRequested,
  list,
  select,
  addServer,
  signInToConnect,
  onError,
}: {
  applicationWindowWebContentsIds: ReadonlySet<number>;
  onListRequested(): void;
  list(webContentsId: number): BbDesktopServerList;
  select(webContentsId: number, id: string): Promise<void>;
  addServer(webContentsId: number): void;
  signInToConnect(webContentsId: number): void;
  onError(error: unknown): void;
}): void {
  const fromApplicationWindow = (
    event: IpcMainEvent | IpcMainInvokeEvent,
  ): boolean =>
    applicationWindowWebContentsIds.has(event.sender.id) &&
    event.senderFrame === event.sender.mainFrame;
  ipcMain.handle(BB_DESKTOP_GET_SERVER_CHOICES_CHANNEL, (event) => {
    if (!fromApplicationWindow(event)) {
      throw new Error("Server choices are limited to bb windows");
    }
    onListRequested();
    return list(event.sender.id);
  });
  ipcMain.on(BB_DESKTOP_SELECT_SERVER_CHANNEL, (event, payload: unknown) => {
    const parsed = bbDesktopServerChoiceSchema.shape.id.safeParse(payload);
    if (!fromApplicationWindow(event) || !parsed.success) return;
    if (
      !list(event.sender.id).servers.some(
        (choice) => choice.id === parsed.data && !choice.active,
      )
    )
      return;
    void select(event.sender.id, parsed.data).catch(onError);
  });
  ipcMain.on(BB_DESKTOP_ADD_SERVER_CHANNEL, (event) => {
    if (fromApplicationWindow(event)) addServer(event.sender.id);
  });
  ipcMain.on(BB_DESKTOP_SIGN_IN_TO_CONNECT_CHANNEL, (event) => {
    if (
      fromApplicationWindow(event) &&
      bbDesktopConnectSignInLabel(
        list(event.sender.id).connectServersSkipReason,
      ) !== null
    )
      signInToConnect(event.sender.id);
  });
}
