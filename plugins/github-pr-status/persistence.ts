import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { pullRequestSchema, type PullRequest } from "./contract.js";

const PERSISTENCE_ENABLED = true;
const PERSISTENCE_VERSION = 1;

const snapshotRow = z.object({
  url: z.string().url(),
  content: z
    .string()
    .transform((value, ctx): unknown => {
      try {
        return JSON.parse(value);
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid snapshot JSON" });
        return z.NEVER;
      }
    })
    .pipe(pullRequestSchema),
  fetched_at: z.number(),
});
const linkRow = z.object({
  environment_id: z.string(),
  url: z.string().url().nullable(),
  branch: z.string().nullable(),
  discovered_at: z.number(),
});
const historyRow = z.object({
  environment_id: z.string(),
  url: z.string().url(),
  seen_at: z.number(),
});

export function createPullRequestPersistence(storage: BbPluginApi["storage"]) {
  if (!PERSISTENCE_ENABLED)
    return {
      snapshots: () => [],
      links: () => [],
      history: () => [],
      saveSnapshot() {},
      link() {},
      removeEnvironment() {},
    };
  const db = storage.database();
  storage.migrate(db, [
    `CREATE TABLE snapshots (
      url TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE TABLE links (
      environment_id TEXT PRIMARY KEY,
      url TEXT,
      branch TEXT,
      discovered_at INTEGER NOT NULL
    );
    CREATE INDEX links_url ON links(url);`,
    `CREATE TABLE history (
      environment_id TEXT NOT NULL,
      url TEXT NOT NULL,
      seen_at INTEGER NOT NULL,
      PRIMARY KEY (environment_id, url)
    );
    CREATE INDEX history_url ON history(url);
    INSERT INTO history (environment_id, url, seen_at)
      SELECT environment_id, url, discovered_at FROM links WHERE url IS NOT NULL;`,
  ]);
  if (db.pragma("user_version", { simple: true }) !== PERSISTENCE_VERSION)
    db.transaction(() => {
      db.exec("DELETE FROM links; DELETE FROM history; DELETE FROM snapshots;");
      db.pragma(`user_version = ${PERSISTENCE_VERSION}`);
    })();
  const prune = () =>
    db
      .prepare(
        `DELETE FROM snapshots WHERE NOT EXISTS (SELECT 1 FROM links WHERE links.url = snapshots.url)
        AND NOT EXISTS (SELECT 1 FROM history WHERE history.url = snapshots.url)`,
      )
      .run();
  function readRows<T>(
    table: "snapshots" | "links" | "history",
    schema: z.ZodType<T>,
  ) {
    const valid: T[] = [];
    for (const raw of db
      .prepare(`SELECT rowid AS row_id, * FROM ${table}`)
      .all()) {
      const result = schema.safeParse(raw);
      if (result.success) {
        valid.push(result.data);
        continue;
      }
      const identity = z.object({ row_id: z.number() }).safeParse(raw);
      if (!identity.success) continue;
      db.transaction(() => {
        if (table === "snapshots")
          for (const referencing of ["links", "history"])
            db.prepare(
              `DELETE FROM ${referencing} WHERE url = (SELECT url FROM snapshots WHERE rowid = ?)`,
            ).run(identity.data.row_id);
        db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(
          identity.data.row_id,
        );
      })();
    }
    return valid;
  }
  prune();
  return {
    snapshots() {
      return readRows("snapshots", snapshotRow).map((row) => ({
        pullRequest: row.content,
        fetchedAt: row.fetched_at,
      }));
    },
    links() {
      const links = readRows("links", linkRow).map((row) => ({
        environmentId: row.environment_id,
        url: row.url,
        branch: row.branch,
        discoveredAt: row.discovered_at,
      }));
      prune();
      return links;
    },
    history() {
      return readRows("history", historyRow).map((row) => ({
        environmentId: row.environment_id,
        url: row.url,
        seenAt: row.seen_at,
      }));
    },
    saveSnapshot(pullRequest: PullRequest, fetchedAt: number) {
      db.prepare(
        `INSERT INTO snapshots (url, content, fetched_at) VALUES (?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET content = excluded.content, fetched_at = excluded.fetched_at
        WHERE snapshots.content != excluded.content`,
      ).run(pullRequest.url, JSON.stringify(pullRequest), fetchedAt);
    },
    link(
      environmentId: string,
      url: string | null,
      branch: string | null,
      discoveredAt: number,
    ) {
      db.transaction(() => {
        const { changes } = db
          .prepare(
            `INSERT INTO links (environment_id, url, branch, discovered_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(environment_id) DO UPDATE SET url = excluded.url, branch = excluded.branch,
          discovered_at = excluded.discovered_at
          WHERE links.url IS NOT excluded.url OR links.branch IS NOT excluded.branch`,
          )
          .run(environmentId, url, branch, discoveredAt);
        if (url !== null)
          db.prepare(
            "INSERT INTO history (environment_id, url, seen_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
          ).run(environmentId, url, discoveredAt);
        if (changes > 0) prune();
      })();
    },
    removeEnvironment(environmentId: string) {
      db.transaction(() => {
        for (const table of ["links", "history"])
          db.prepare(`DELETE FROM ${table} WHERE environment_id = ?`).run(
            environmentId,
          );
        prune();
      })();
    },
  };
}
export type PullRequestPersistence = ReturnType<
  typeof createPullRequestPersistence
>;
