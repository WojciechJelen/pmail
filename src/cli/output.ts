import { ExitCode, PmailError, toPmailError } from "../core/errors";

export interface GlobalOpts {
  json?: boolean;
  fields?: string;
}

export const jsonMode = (opts: GlobalOpts) => Boolean(opts.json) || !process.stdout.isTTY;

const pick = (obj: unknown, fields: string[]) =>
  obj && typeof obj === "object"
    ? Object.fromEntries(fields.filter((f) => f in obj).map((f) => [f, (obj as Record<string, unknown>)[f]]))
    : obj;

const LIST_KEYS = ["messages", "folders", "checks"];

// --fields trims the items of a list result (e.g. `messages`), or the object itself for single results.
export function applyFields(data: unknown, fieldsOpt: string | undefined): unknown {
  if (!fieldsOpt || !data || typeof data !== "object") return data;
  const fields = fieldsOpt.split(",").map((f) => f.trim()).filter(Boolean);
  if (Array.isArray(data)) return data.map((d) => pick(d, fields));
  const entries = Object.entries(data);
  const listKey = entries.find(([k, v]) => LIST_KEYS.includes(k) && Array.isArray(v))?.[0];
  if (!listKey) return { ...(pick(data, fields) as object), ...("untrusted" in data && { untrusted: true }) };
  return Object.fromEntries(
    entries.map(([k, v]) => [k, k === listKey ? (v as unknown[]).map((d) => pick(d, fields)) : v]),
  );
}

export function emit<T>(data: T, opts: GlobalOpts, human?: (data: T) => string): void {
  if (jsonMode(opts) || !human) {
    process.stdout.write(JSON.stringify(applyFields(data, opts.fields)) + "\n");
  } else {
    process.stdout.write(human(data) + "\n");
  }
}

export function errorPayload(err: PmailError) {
  return { error: { code: err.code, message: err.message, ...(err.hint && { hint: err.hint }), ...err.details } };
}

export function fail(err: unknown, opts: GlobalOpts): never {
  const e = toPmailError(err);
  if (jsonMode(opts)) {
    process.stderr.write(JSON.stringify(errorPayload(e)) + "\n");
  } else {
    process.stderr.write(`error: ${e.message}\n${e.hint ? `hint: ${e.hint}\n` : ""}`);
    if (e.details) process.stderr.write(JSON.stringify(e.details, null, 2) + "\n");
  }
  process.exit(e.exitCode);
}

export async function run<T>(opts: GlobalOpts, action: () => Promise<T>, human?: (data: T) => string): Promise<void> {
  try {
    emit(await action(), opts, human);
    process.exit(ExitCode.ok);
  } catch (err) {
    fail(err, opts);
  }
}
