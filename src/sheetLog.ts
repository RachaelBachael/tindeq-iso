// Automatic session logging to a Google Sheet through an Apps Script web app.
// The endpoint URL (the Apps Script deployment, which acts as the key) lives
// only in this browser's localStorage, never in the public source. It is
// pasted once into the app's setup field.

export type Exercise = "sp" | "bc" | "dl";
export const EXERCISES: Exercise[] = ["sp", "bc", "dl"];
export const EXERCISE_NAMES: Record<Exercise, string> = {
  sp: "Shoulder press",
  bc: "Biceps curl",
  dl: "Deadlift",
};

export interface SheetState {
  date: string;
  weights: Record<Exercise, number | string>;
  reps: Record<Exercise, number | string>;
}

export interface LogEntry {
  exercise: Exercise;
  weight: number;
  successes: number;
  attempts: number;
}

const CONFIG_KEY = "isoLog.config";
const PENDING_KEY = "isoLog.pending";

interface Config {
  url: string;
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: logging still works for this page load */
  }
}

let memoryConfig: Config | null = null;

/** Saves the Apps Script web-app URL for this browser. */
export function setEndpoint(url: string): boolean {
  const u = url.trim();
  if (!/^https:\/\/script\.google\.com\/(a\/macros\/[\w.-]+|macros)\/s\/[\w-]+\/exec$/.test(u)) return false;
  memoryConfig = { url: u };
  safeSet(CONFIG_KEY, JSON.stringify(memoryConfig));
  return true;
}

export function getConfig(): Config | null {
  if (memoryConfig) return memoryConfig;
  const raw = safeGet(CONFIG_KEY);
  if (!raw) return null;
  try {
    memoryConfig = JSON.parse(raw) as Config;
    return memoryConfig;
  } catch {
    return null;
  }
}

export async function fetchState(): Promise<SheetState> {
  const cfg = getConfig();
  if (!cfg) throw new Error("Logging not set up");
  const res = await fetch(cfg.url);
  const body = await res.json();
  if (!body.ok) throw new Error(body.error ?? "Sheet error");
  return body.state as SheetState;
}

type Stamped = LogEntry & { day: string };
type Pending = Partial<Record<Exercise, Stamped>>;

function localDay(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function readPending(): Pending {
  try {
    return JSON.parse(safeGet(PENDING_KEY) ?? "{}") as Pending;
  } catch {
    return {};
  }
}

async function post({ day: _day, ...entry }: Stamped): Promise<void> {
  const cfg = getConfig();
  if (!cfg) throw new Error("Logging not set up");
  // text/plain keeps this a "simple" request, so Apps Script needs no CORS preflight.
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(entry),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error ?? "Sheet error");
}

/**
 * Logs the latest count for an exercise. Only the newest entry per exercise is
 * kept, so a failed send is simply retried with fresher numbers next time.
 */
export async function logEntry(entry: LogEntry): Promise<void> {
  const pending = readPending();
  pending[entry.exercise] = { ...entry, day: localDay() };
  safeSet(PENDING_KEY, JSON.stringify(pending));
  await flushPending();
}

let flushing: Promise<void> | null = null;

export function flushPending(): Promise<void> {
  if (flushing) return flushing.then(() => flushPending());
  flushing = (async () => {
    const pending = readPending();
    for (const ex of EXERCISES) {
      const entry = pending[ex];
      if (!entry) continue;
      // A count left unsent from an earlier day would land on today's row; drop it.
      if (entry.day !== localDay()) {
        const now = readPending();
        delete now[ex];
        safeSet(PENDING_KEY, JSON.stringify(now));
        continue;
      }
      await post(entry);
      const now = readPending();
      // Only clear it if nothing newer arrived while we were sending.
      if (JSON.stringify(now[ex]) === JSON.stringify(entry)) {
        delete now[ex];
        safeSet(PENDING_KEY, JSON.stringify(now));
      }
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}
