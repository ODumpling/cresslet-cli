// Server API. Runs in a sandbox on Cresslet; handles requests matching `routes` in cresslet.json.
import type { Env } from "./cresslet";

let ready: Promise<void> | undefined;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    await (ready ??= env.db.exec(
      "CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL)",
    ));
    const url = new URL(req.url);

    if (url.pathname === "/api/health") return Response.json({ ok: true, app: env.app.name });

    if (url.pathname === "/api/visits") {
      if (req.method === "POST") {
        await env.db.run(
          "INSERT INTO counters (name, n) VALUES ('visits', 1) ON CONFLICT (name) DO UPDATE SET n = n + 1",
        );
      }
      const row = await env.db.first<{ n: number }>("SELECT n FROM counters WHERE name = 'visits'");
      return Response.json({ visits: row?.n ?? 0 });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
};
