import { describe, expect, it } from "vitest";
import {
  buildDesktopServerChoices,
  customServerId,
  serverTargetName,
} from "../src/server-list.js";
import {
  BUILTIN_SERVER_NAME,
  createServerTargetStore,
  type ConnectServerRef,
  type DesktopServerTarget,
  type ServerTargetStore,
} from "../src/server-target.js";

const LOCAL_URL = "http://127.0.0.1:38886";

function createStore() {
  return createServerTargetStore({
    storagePath: "/test/server-target.json",
    fs: {
      mkdir: async () => undefined,
      readFile: async () => "",
      writeFile: async () => undefined,
    },
  });
}

function choicesFor(
  store: ServerTargetStore,
  connectServers: readonly ConnectServerRef[],
  activeTarget: DesktopServerTarget | null,
) {
  return buildDesktopServerChoices({
    activeTarget,
    connectServers,
    customServers: store.getCustomServers(),
    getConnectServerName: (handle) => store.getConnectServerName(handle),
    showBuiltinServer: store.getShowBuiltinServer(),
    builtinServerUrl: LOCAL_URL,
  });
}

const servers = [
  { handle: "brsbl", name: "default", url: "https://brsbl.getbb.app" },
  {
    handle: "brsbl-bbox",
    name: "brsbl-bbox",
    url: "https://brsbl-bbox.getbb.app",
  },
];

describe("buildDesktopServerChoices", () => {
  it("lists each account server once by hostname after adopting saved custom URLs", async () => {
    const store = createStore();
    await store.addCustomServerUrl("https://brsbl.getbb.app");
    await store.addCustomServerUrl("https://brsbl-bbox.getbb.app");
    const teamUrl = await store.addCustomServerUrl(
      "https://bb.example.com/team",
    );

    await store.adoptConnectServers(servers);

    expect(
      choicesFor(store, servers, { kind: "custom", url: teamUrl }),
    ).toEqual([
      {
        id: "builtin",
        name: BUILTIN_SERVER_NAME,
        origin: LOCAL_URL,
        kind: "local",
        active: false,
      },
      {
        id: "connect:brsbl",
        name: "brsbl.getbb.app",
        origin: "https://brsbl.getbb.app",
        kind: "account",
        active: false,
      },
      {
        id: "connect:brsbl-bbox",
        name: "brsbl-bbox.getbb.app",
        origin: "https://brsbl-bbox.getbb.app",
        kind: "account",
        active: false,
      },
      {
        id: customServerId("https://bb.example.com/team"),
        name: "bb.example.com",
        origin: "https://bb.example.com",
        kind: "custom",
        active: true,
      },
    ]);
  });

  it("labels account servers by their saved name, keeping a renamed custom URL's name", async () => {
    const store = createStore();
    const bboxUrl = await store.addCustomServerUrl(
      "https://brsbl-bbox.getbb.app",
      { name: "Devbox" },
    );
    await store.setWindowTarget("main", { kind: "custom", url: bboxUrl });
    await store.setConnectServerName("brsbl", "  Studio   Mac ");

    await store.adoptConnectServers(servers);
    const activeTarget = store.getWindowTarget("main");

    expect(choicesFor(store, servers, activeTarget)).toEqual([
      {
        id: "builtin",
        name: BUILTIN_SERVER_NAME,
        origin: LOCAL_URL,
        kind: "local",
        active: false,
      },
      {
        id: "connect:brsbl",
        name: "Studio Mac",
        origin: "https://brsbl.getbb.app",
        kind: "account",
        active: false,
      },
      {
        id: "connect:brsbl-bbox",
        name: "Devbox",
        origin: "https://brsbl-bbox.getbb.app",
        kind: "account",
        active: true,
      },
    ]);

    await store.setConnectServerName("brsbl-bbox", null);
    expect(choicesFor(store, servers, activeTarget)[2]).toEqual({
      id: "connect:brsbl-bbox",
      name: "brsbl-bbox.getbb.app",
      origin: "https://brsbl-bbox.getbb.app",
      kind: "account",
      active: true,
    });
  });

  it("marks only the asking window's server and keeps a hidden built-in server for the window that shows it", async () => {
    const store = createStore();
    const customUrl = await store.addCustomServerUrl("https://bb.example.com");
    await store.setShowBuiltinServer(false);

    expect(
      choicesFor(store, servers, { kind: "custom", url: customUrl }),
    ).toEqual([
      {
        id: "connect:brsbl",
        name: "brsbl.getbb.app",
        origin: "https://brsbl.getbb.app",
        kind: "account",
        active: false,
      },
      {
        id: "connect:brsbl-bbox",
        name: "brsbl-bbox.getbb.app",
        origin: "https://brsbl-bbox.getbb.app",
        kind: "account",
        active: false,
      },
      {
        id: customServerId(customUrl),
        name: "bb.example.com",
        origin: "https://bb.example.com",
        kind: "custom",
        active: true,
      },
    ]);
    expect(choicesFor(store, servers, { kind: "builtin" })[0]).toEqual({
      id: "builtin",
      name: BUILTIN_SERVER_NAME,
      origin: LOCAL_URL,
      kind: "local",
      active: true,
    });
  });
});

describe("serverTargetName", () => {
  it("names window titles like the Server menu", async () => {
    const store = createStore();
    const customUrl = await store.addCustomServerUrl(
      "https://bb.example.com:8443",
      { name: "Office" },
    );
    const names = {
      customServers: store.getCustomServers(),
      getConnectServerName: (handle: string) =>
        store.getConnectServerName(handle),
    };
    const connect = { kind: "connect", server: servers[0] } as const;

    expect(serverTargetName({ kind: "builtin" }, names)).toBe(
      BUILTIN_SERVER_NAME,
    );
    expect(serverTargetName({ kind: "custom", url: customUrl }, names)).toBe(
      "Office",
    );
    expect(
      serverTargetName({ kind: "custom", url: "https://other.example" }, names),
    ).toBe("other.example");
    expect(serverTargetName(connect, names)).toBe("brsbl.getbb.app");
    await store.setConnectServerName("brsbl", "Studio");
    expect(serverTargetName(connect, names)).toBe("Studio");
  });
});
