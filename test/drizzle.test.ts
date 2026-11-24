// cresslet/drizzle (sdk/drizzle.ts) on `cresslet dev`: queries (joins whose columns share a name), orm.batch, the
// relational API, and migrate() with migrations as drizzle-kit generates them (driver: "durable-sqlite"), including a
// rebuild of a referenced table and requests starting together.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dev } from "../lib/dev.ts";
import { loadProject } from "../lib/util.ts";
import * as orm from "cresslet/drizzle"; // the package's own export (self-reference)

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// drizzle-kit 0.31 output for schema v1 (users, todos → users ON DELETE CASCADE), then users.name made nullable: a
// rebuild of users, the referenced table, between PRAGMA foreign_keys=OFF and ON.
const M0000 = `CREATE TABLE \`todos\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`user_id\` integer NOT NULL,
	\`title\` text NOT NULL,
	\`done\` integer DEFAULT false NOT NULL,
	FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE \`users\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`email\` text NOT NULL,
	\`name\` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`users_email_unique\` ON \`users\` (\`email\`);`;
const M0001 = `PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE \`__new_users\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`email\` text NOT NULL,
	\`name\` text
);
--> statement-breakpoint
INSERT INTO \`__new_users\`("id", "email", "name") SELECT "id", "email", "name" FROM \`users\`;--> statement-breakpoint
DROP TABLE \`users\`;--> statement-breakpoint
ALTER TABLE \`__new_users\` RENAME TO \`users\`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX \`users_email_unique\` ON \`users\` (\`email\`);`;
const entry = (idx: number, when: number, tag: string) => ({ idx, version: "6", when, tag, breakpoints: true });
const JOURNAL = { version: "7", dialect: "sqlite", entries: [entry(0, 1795547696216, "0000_init"), entry(1, 1795547696627, "0001_users_name_nullable")] };

const SERVER = `import { db } from "cresslet";
import { drizzle, migrate } from "cresslet/drizzle";
import { eq, relations, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import migrations from "../drizzle/migrations.js";

const users = sqliteTable("users", { id: integer().primaryKey(), email: text().notNull().unique(), name: text() });
const todos = sqliteTable("todos", {
  id: integer().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text().notNull(),
  done: integer({ mode: "boolean" }).notNull().default(false),
});
const usersRelations = relations(users, ({ many }) => ({ todos: many(todos) }));
const todosRelations = relations(todos, ({ one }) => ({ user: one(users, { fields: [todos.userId], references: [users.id] }) }));
const orm = drizzle(db, { schema: { users, todos, usersRelations, todosRelations } }); // module top level: fine
// only the first migration (the schema before users.name became nullable)
const first = { journal: { ...migrations.journal, entries: migrations.journal.entries.slice(0, 1) }, migrations: migrations.migrations };
const error = async (f) => { try { await f(); return null; } catch (e) { return e.cause?.message ?? e.message; } }; // (drizzle wraps errors: "Failed query")

export default { async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === "/api/v1") {
    await migrate(db, first);
    await orm.insert(users).values({ id: 1, email: "a@x", name: "A" });
    await orm.insert(todos).values([{ userId: 1, title: "one" }, { userId: 1, title: "two", done: true }]);
    return Response.json(await db.query("SELECT tag FROM (SELECT 1 AS tag) WHERE 0")); // []
  }
  await migrate(db, migrations);
  if (path === "/api/migrations") return Response.json(await db.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at"));
  if (path === "/api/check") {
    const joined = await orm.select({ todo: todos.id, user: users.id, title: todos.title, done: todos.done })
      .from(todos).innerJoin(users, eq(users.id, todos.userId)).orderBy(todos.id);
    const whole = await orm.select().from(todos).innerJoin(users, eq(users.id, todos.userId)).where(eq(todos.title, "two")).get();
    const nested = await orm.query.users.findMany({ with: { todos: { columns: { title: true } } } });
    const nobody = await orm.select().from(users).where(eq(users.id, 99)).get();
    const fk = await error(() => orm.insert(todos).values({ userId: 42, title: "orphan" }));
    const failedBatch = await error(() => orm.batch([
      orm.insert(users).values({ id: 2, email: "b@x" }),
      orm.insert(users).values({ id: 3, email: "a@x" }), // unique email: fails
    ]));
    const afterBatch = (await orm.select({ n: sql\`count(*)\` }).from(users).get()).n;
    const [inserted, updated, counted] = await orm.batch([
      orm.insert(users).values({ id: 2, email: "b@x" }).returning({ id: users.id }),
      orm.update(todos).set({ done: true }).where(eq(todos.userId, 1)),
      orm.select({ n: sql\`count(*)\` }).from(users),
    ]);
    const tx = await error(() => orm.transaction(async () => {}));
    const fkOn = (await db.first("PRAGMA foreign_keys")).foreign_keys;
    return Response.json({ joined, whole, nested, nobody, fk, failedBatch, afterBatch, inserted, updated: updated.changes, counted, tx, fkOn });
  }
  return new Response("not found", { status: 404 });
} };
`;

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cresslet-drizzle-"));
  fs.cpSync(path.join(ROOT, "test", "fixture"), dir, { recursive: true });
  fs.rmSync(path.join(dir, "server"), { recursive: true });
  fs.mkdirSync(path.join(dir, "server"));
  fs.writeFileSync(path.join(dir, "server", "index.js"), SERVER);
  fs.mkdirSync(path.join(dir, "drizzle", "meta"), { recursive: true });
  fs.writeFileSync(path.join(dir, "drizzle", "meta", "_journal.json"), JSON.stringify(JOURNAL, null, 2));
  fs.writeFileSync(path.join(dir, "drizzle", "0000_init.sql"), M0000);
  fs.writeFileSync(path.join(dir, "drizzle", "0001_users_name_nullable.sql"), M0001);
  // as drizzle-kit writes it
  fs.writeFileSync(path.join(dir, "drizzle", "migrations.js"), `import journal from './meta/_journal.json';
import m0000 from './0000_init.sql';
import m0001 from './0001_users_name_nullable.sql';

  export default {
    journal,
    migrations: {
      m0000,
m0001
    }
  }
  `);
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.symlinkSync(ROOT, path.join(dir, "node_modules", "cresslet"), "dir");
  fs.symlinkSync(path.join(ROOT, "node_modules", "drizzle-orm"), path.join(dir, "node_modules", "drizzle-orm"), "dir");
  return dir;
}

test("cresslet/drizzle on cresslet dev: migrations, joins, batch, relational queries", async () => {
  const d = await dev(loadProject(project()), { port: 0, log: () => {} });
  const get = async (p: string) => {
    const r = await fetch(d.url + p);
    const text = await r.text();
    assert.equal(r.status, 200, text);
    return JSON.parse(text) as unknown;
  };
  try {
    await get("/api/v1"); // the first migration, and rows in both tables
    // requests starting together: each migration applied once, the rebuild of users kept its todos (no cascade)
    const all = await Promise.all(Array.from({ length: 8 }, () => get("/api/migrations")));
    for (const m of all) assert.deepEqual(m, [{ hash: "", created_at: 1795547696216 }, { hash: "", created_at: 1795547696627 }]);
    const r = (await get("/api/check")) as Record<string, unknown>;
    assert.deepEqual(r.joined, [{ todo: 1, user: 1, title: "one", done: false }, { todo: 2, user: 1, title: "two", done: true }]);
    assert.deepEqual(r.whole, { todos: { id: 2, userId: 1, title: "two", done: true }, users: { id: 1, email: "a@x", name: "A" } });
    assert.deepEqual(r.nested, [{ id: 1, email: "a@x", name: "A", todos: [{ title: "one" }, { title: "two" }] }]);
    assert.equal(r.nobody, undefined);
    assert.match(String(r.fk), /FOREIGN KEY constraint failed/, "foreign keys back on after the rebuild");
    assert.equal(r.fkOn, 1);
    assert.match(String(r.failedBatch), /UNIQUE constraint failed/);
    assert.equal(r.afterBatch, 1, "a failing batch writes nothing");
    assert.deepEqual([r.inserted, r.updated, r.counted], [[{ id: 2 }], 2, [{ n: 2 }]]);
    assert.match(String(r.tx), /orm\.transaction\(\) isn't supported.*orm\.batch/);
  } finally {
    await d.close();
  }
});

test("cresslet/drizzle: misuse says what to do", async () => {
  // @ts-expect-error -- misuse on purpose: no database
  assert.throws(() => orm.drizzle(undefined), /drizzle\(db\) with `import \{ db \} from "cresslet"`/);
  const db = { raw: async () => [], batch: async () => [], run: async () => ({ changes: 0, lastInsertRowid: 0 }), first: async () => null, exec: async () => {} };
  // @ts-expect-error -- misuse on purpose: not drizzle/migrations.js
  await assert.rejects(orm.migrate(db, { "0000_init.sql": "" }), /takes drizzle\/migrations\.js.*durable-sqlite/s);
  const journal = (breakpoints: boolean) => ({ entries: [{ idx: 0, when: 1, tag: "0000_x", breakpoints }] });
  // @ts-expect-error -- a stand-in for the SDK's db (what migrate uses of it)
  await assert.rejects(orm.migrate(db, { journal: journal(true), migrations: {} }), /0000_x is missing/);
  // @ts-expect-error -- as above
  await assert.rejects(orm.migrate(db, { journal: journal(false), migrations: { m0000: "SELECT 1" } }), /breakpoints: true/);
  // @ts-expect-error -- as above
  await assert.rejects(orm.migrate(db, { journal: journal(true), migrations: { m0000: "PRAGMA journal_mode = DELETE" } }), /PRAGMA can't run/);
});
