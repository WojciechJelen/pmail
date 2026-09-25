import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./config";

// Bridge strips In-Reply-To/References from drafts it stores, but keeps the draft's Message-ID.
// So reply headers are kept here, keyed by the draft's Message-ID, and re-applied at send time.

export interface ReplyHeaders {
  inReplyTo: string;
  references: string[];
  createdAt: string;
}

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const storePath = () => process.env.PMAIL_REPLIES ?? join(configDir(), "replies.json");

function load(): Record<string, ReplyHeaders> {
  const path = storePath();
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

function save(store: Record<string, ReplyHeaders>) {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
}

export function rememberReply(draftMessageId: string, inReplyTo: string, references: string[]) {
  const now = Date.now();
  const store = Object.fromEntries(
    Object.entries(load()).filter(([, v]) => now - Date.parse(v.createdAt) < MAX_AGE_MS),
  );
  store[draftMessageId] = { inReplyTo, references, createdAt: new Date(now).toISOString() };
  save(store);
}

export function replyHeadersFor(draftMessageId: string | undefined): ReplyHeaders | undefined {
  return draftMessageId ? load()[draftMessageId] : undefined;
}

export function forgetReply(draftMessageId: string) {
  const store = load();
  if (!(draftMessageId in store)) return;
  delete store[draftMessageId];
  save(store);
}

// Replaces In-Reply-To/References in the raw message's header block (including folded lines).
export function withReplyHeaders(source: Buffer, headers: Pick<ReplyHeaders, "inReplyTo" | "references">): Buffer {
  const raw = source.toString("latin1");
  const split = raw.search(/\r?\n\r?\n/);
  const [head, body] = split === -1 ? [raw, ""] : [raw.slice(0, split), raw.slice(split)];
  const eol = head.includes("\r\n") ? "\r\n" : "\n";
  const kept: string[] = [];
  let dropping = false;
  for (const line of head.split(/\r?\n/)) {
    const folded = /^[ \t]/.test(line);
    if (!folded) dropping = /^(in-reply-to|references)\s*:/i.test(line);
    if (!dropping) kept.push(line);
  }
  kept.push(`In-Reply-To: ${headers.inReplyTo}`, `References: ${headers.references.join(" ")}`);
  return Buffer.from(kept.join(eol) + body, "latin1");
}
