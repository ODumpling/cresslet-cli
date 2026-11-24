// Live Link v2 credentials (`cresslet connect`, Remember this agent): one file per remembered agent under
// <config dir>/agents/<credential id>.json, beside the account token and protected like it (0600, written to a temp
// file and renamed into place), and the project each folder last used (pins.json). A credential names the API origin
// and the login (a hash of its token) it was enrolled with: reconnecting needs both that token and its secret.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configDir } from "./util.ts";

export interface AgentCredentialFile {
  id: string;
  secret: string;
  /** API base it was enrolled against (`cresslet connect` only talks to that origin). */
  api: string;
  /** sha256(token), first 16 hex: which login it belongs to (the token itself isn't copied here). */
  login: string;
  tokenId?: string;
  label: string;
  createdAt: string;
}

export interface Pin {
  handle: string;
  credentialId: string;
  projectName: string;
}

export const loginKey = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 16);
export const newSecret = () => randomBytes(32).toString("base64url");
export const secretHash = (secret: string) => createHash("sha256").update(secret).digest("hex");

/** Writes `data` as JSON to `file`, 0600, through a temp file in the same directory and a rename. */
function writeAtomic(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Remembered agents and pins for one API origin + login. `dir`: the CLI's config directory. */
export function agentStore({ dir = configDir(), api, token }: { dir?: string; api: string; token: string }) {
  const agentsDir = path.join(dir, "agents");
  const pinsFile = path.join(dir, "pins.json");
  const login = loginKey(token);
  const pinKey = (cwd: string) => `${api}|${login}|${path.resolve(cwd)}`;
  const readPins = (): Record<string, Pin> => {
    try {
      return JSON.parse(fs.readFileSync(pinsFile, "utf8"));
    } catch {
      return {};
    }
  };
  return {
    api,
    login,
    /** This origin + login's credentials, read again each time (logout may have deleted them meanwhile). */
    list(): AgentCredentialFile[] {
      let names: string[];
      try {
        names = fs.readdirSync(agentsDir);
      } catch {
        return [];
      }
      const out: AgentCredentialFile[] = [];
      for (const n of names) {
        if (!n.endsWith(".json")) continue;
        try {
          const c = JSON.parse(fs.readFileSync(path.join(agentsDir, n), "utf8")) as AgentCredentialFile;
          if (c.api === api && c.login === login && SAFE_ID.test(c.id) && typeof c.secret === "string") out.push(c);
        } catch { /* unreadable: skipped */ }
      }
      return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    save(c: Omit<AgentCredentialFile, "api" | "login" | "createdAt">) {
      if (!SAFE_ID.test(c.id)) throw new Error(`bad credential id: ${c.id}`);
      const rec: AgentCredentialFile = { ...c, api, login, createdAt: new Date().toISOString() };
      writeAtomic(path.join(agentsDir, `${c.id}.json`), rec);
      return rec;
    },
    remove(id: string) {
      if (SAFE_ID.test(id)) fs.rmSync(path.join(agentsDir, `${id}.json`), { force: true });
    },
    /** Deletes every credential of this origin + login and its pins (logout). Resolves to the ids removed. */
    removeAll(): string[] {
      const ids = this.list().map((c) => c.id);
      for (const id of ids) this.remove(id);
      const pins = readPins();
      const prefix = `${api}|${login}|`;
      let changed = false;
      for (const k of Object.keys(pins)) if (k.startsWith(prefix)) (delete pins[k], changed = true);
      if (changed) writeAtomic(pinsFile, pins);
      return ids;
    },
    /** The project this folder last used, with this origin + login. */
    pin(cwd: string): Pin | null {
      const p = readPins()[pinKey(cwd)];
      return p && typeof p.handle === "string" && typeof p.credentialId === "string" ? p : null;
    },
    setPin(cwd: string, pin: Pin | null) {
      const pins = readPins();
      if (pin) pins[pinKey(cwd)] = pin;
      else delete pins[pinKey(cwd)];
      writeAtomic(pinsFile, pins);
    },
  };
}

export type AgentStore = ReturnType<typeof agentStore>;
