import { randomUUID } from "node:crypto";
import { ImapFlow, type SearchObject } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer";
import { loadPassword, tlsOptions, type Config } from "./config";
import { notFoundError, toPmailError, validationError } from "./errors";
import { formatId, parseId } from "./ids";
import { rememberReply } from "./replies";
import { normalizeSubject, parseSource, toEnvelope, toMessage } from "./parse";
import type { DraftInput, Envelope, EnvelopeQuery, Folder, Message } from "./types";

export async function connectImap(cfg: Config): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: cfg.imap.host,
    port: cfg.imap.port,
    secure: false,
    auth: { user: cfg.email, pass: loadPassword(cfg) },
    tls: tlsOptions(cfg),
    logger: false,
    connectionTimeout: 10_000,
  });
  try {
    await client.connect();
  } catch (err) {
    throw toPmailError(err, "IMAP");
  }
  return client;
}

export async function withImap<T>(cfg: Config, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = await connectImap(cfg);
  try {
    return await fn(client);
  } catch (err) {
    throw toPmailError(err, "IMAP");
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function listFolders(client: ImapFlow): Promise<Folder[]> {
  const boxes = await client.list({ statusQuery: { messages: true, unseen: true } });
  return boxes
    .filter((b) => !b.flags.has("\\Noselect"))
    .map((b) => ({
      path: b.path,
      specialUse: b.specialUse ?? null,
      total: b.status?.messages ?? 0,
      unread: b.status?.unseen ?? 0,
    }));
}

// Accepts an exact path, a case-insensitive path, or a special-use name like "trash"/"archive".
export async function resolveFolder(client: ImapFlow, name: string): Promise<string> {
  const boxes = await client.list();
  const lower = name.toLowerCase();
  const match =
    boxes.find((b) => b.path === name) ??
    boxes.find((b) => b.path.toLowerCase() === lower) ??
    boxes.find((b) => b.specialUse?.toLowerCase() === `\\${lower}`);
  if (!match) {
    throw validationError(`Unknown folder "${name}"`, `Known folders: ${boxes.map((b) => b.path).join(", ")}`);
  }
  return match.path;
}

async function specialFolder(client: ImapFlow, use: "\\Drafts" | "\\Sent"): Promise<string> {
  const boxes = await client.list();
  const box = boxes.find((b) => b.specialUse === use);
  if (!box) throw notFoundError(`No ${use} folder found on the server`);
  return box.path;
}

export function toSearchObject(q: EnvelopeQuery): SearchObject {
  const s: SearchObject = {};
  if (q.from) s.from = q.from;
  if (q.to) s.to = q.to;
  if (q.subject) s.subject = q.subject;
  if (q.text) s.text = q.text;
  if (q.since) s.since = q.since;
  if (q.before) s.before = q.before;
  if (q.unread) s.seen = false;
  if (q.starred) s.flagged = true;
  if (Object.keys(s).length === 0) s.all = true;
  return s;
}

export interface EnvelopePage {
  folder: string;
  messages: Envelope[];
  matched: number;
  nextBeforeId: string | null;
}

// Newest first by UID. `beforeId` continues a previous page.
export async function listEnvelopes(
  client: ImapFlow,
  folderName: string,
  query: EnvelopeQuery,
  limit: number,
  beforeId?: string,
): Promise<EnvelopePage> {
  const folder = await resolveFolder(client, folderName);
  const beforeUid = beforeId ? parseId(beforeId).uid : undefined;
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const found = (await client.search(toSearchObject(query), { uid: true })) || [];
    const uids = found.filter((u) => beforeUid === undefined || u < beforeUid).sort((a, b) => b - a);
    const page = uids.slice(0, limit);
    const messages: Envelope[] = [];
    if (page.length > 0) {
      const fetched = await client.fetchAll(
        page.join(","),
        { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true },
        { uid: true },
      );
      fetched.sort((a, b) => b.uid - a.uid);
      for (const m of fetched) messages.push(toEnvelope(folder, m));
    }
    const last = page.at(-1);
    return {
      folder,
      messages,
      matched: uids.length,
      nextBeforeId: uids.length > page.length && last !== undefined ? formatId(folder, last) : null,
    };
  } finally {
    lock.release();
  }
}

async function fetchSource(client: ImapFlow, id: string, markRead: boolean) {
  const { folder, uid } = parseId(id);
  const path = await resolveFolder(client, folder);
  const lock = await client.getMailboxLock(path, { readOnly: !markRead });
  try {
    const msg = await client.fetchOne(String(uid), { uid: true, flags: true, source: true, internalDate: true }, { uid: true });
    if (!msg || !msg.source) {
      throw notFoundError(`Message ${id} not found`, "It may have been moved or deleted. Re-run `pmail list` to get current ids.");
    }
    if (markRead) {
      await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
      msg.flags?.add("\\Seen");
    }
    return { folder: path, msg, source: msg.source };
  } finally {
    lock.release();
  }
}

export async function readMessage(
  client: ImapFlow,
  id: string,
  opts: { maxChars?: number; markRead?: boolean } = {},
): Promise<Message> {
  const { folder, msg, source } = await fetchSource(client, id, opts.markRead ?? false);
  return toMessage(folder, msg, await parseSource(source), opts.maxChars);
}

export async function readAttachment(client: ImapFlow, id: string, index: number) {
  const { source } = await fetchSource(client, id, false);
  const parsed = await parseSource(source);
  const att = parsed.attachments[index];
  if (!att) {
    throw validationError(
      `Message ${id} has no attachment #${index}`,
      `It has ${parsed.attachments.length} attachment(s); indexes come from \`pmail read ${id}\`.`,
    );
  }
  return { filename: att.filename ?? `attachment-${index}`, contentType: att.contentType, content: att.content };
}

export interface ThreadEntry {
  id: string;
  date: string | null;
  from: Envelope["from"];
  subject: string;
  unread: boolean;
}

// Proton Bridge has no THREAD extension, so we gather candidates by subject in the message's
// folder and Sent, then keep only those linked to it through Message-ID / In-Reply-To.
// Candidates are searched by the subject's longest word: Bridge misses whole-subject phrases
// when the subject contains non-ASCII whitespace, and the Message-ID linking does the real filtering.
export async function readThread(client: ImapFlow, id: string): Promise<ThreadEntry[]> {
  const root = await readMessage(client, id, { maxChars: 0 });
  const subject = normalizeSubject(root.subject)
    .split(/\s+/u)
    .reduce((longest, w) => (w.length > longest.length ? w : longest), "");
  const folders = [...new Set([parseId(id).folder, await specialFolder(client, "\\Sent")])];

  type Candidate = ThreadEntry & { messageId?: string; inReplyTo?: string };
  const candidates: Candidate[] = [];
  for (const folder of folders) {
    const path = await resolveFolder(client, folder);
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try {
      const uids = (subject ? await client.search({ subject }, { uid: true }) : false) || [];
      if (uids.length === 0) continue;
      for (const m of await client.fetchAll(uids.join(","), { uid: true, flags: true, envelope: true }, { uid: true })) {
        const env = toEnvelope(path, m);
        candidates.push({
          id: env.id,
          date: env.date,
          from: env.from,
          subject: env.subject,
          unread: env.unread,
          messageId: m.envelope?.messageId,
          inReplyTo: m.envelope?.inReplyTo,
        });
      }
    } finally {
      lock.release();
    }
  }

  const linked = new Set<string>([root.messageId, root.inReplyTo, ...root.references].filter((x): x is string => !!x));
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of candidates) {
      const touches = (c.messageId && linked.has(c.messageId)) || (c.inReplyTo && linked.has(c.inReplyTo));
      if (!touches) continue;
      for (const v of [c.messageId, c.inReplyTo]) {
        if (v && !linked.has(v)) {
          linked.add(v);
          grew = true;
        }
      }
    }
  }

  const seen = new Set<string>();
  return candidates
    .filter((c) => c.id === id || (c.messageId && linked.has(c.messageId)))
    .filter((c) => {
      const key = c.messageId ?? c.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))
    .map(({ messageId, inReplyTo, ...entry }) => entry);
}

export async function moveMessage(client: ImapFlow, id: string, destination: string): Promise<{ id: string | null; folder: string }> {
  const { folder, uid } = parseId(id);
  const [from, to] = [await resolveFolder(client, folder), await resolveFolder(client, destination)];
  const lock = await client.getMailboxLock(from);
  try {
    const res = await client.messageMove(String(uid), to, { uid: true });
    if (!res) throw notFoundError(`Message ${id} not found`);
    const newUid = res.uidMap?.get(uid);
    return { id: newUid ? formatId(to, newUid) : null, folder: to };
  } finally {
    lock.release();
  }
}

export interface FlagChange {
  read?: boolean;
  starred?: boolean;
}

export async function setFlags(client: ImapFlow, id: string, change: FlagChange): Promise<void> {
  const { folder, uid } = parseId(id);
  const lock = await client.getMailboxLock(await resolveFolder(client, folder));
  try {
    const apply = (on: boolean, flag: string) =>
      on
        ? client.messageFlagsAdd(String(uid), [flag], { uid: true })
        : client.messageFlagsRemove(String(uid), [flag], { uid: true });
    if (change.read !== undefined) await apply(change.read, "\\Seen");
    if (change.starred !== undefined) await apply(change.starred, "\\Flagged");
  } finally {
    lock.release();
  }
}

export async function createDraft(client: ImapFlow, cfg: Config, input: DraftInput): Promise<{ id: string }> {
  const headers: Record<string, string> = {};
  let reply: { inReplyTo: string; references: string[] } | undefined;
  let to = input.to;
  let subject = input.subject;
  if (input.replyTo) {
    const orig = await readMessage(client, input.replyTo, { maxChars: 0 });
    if (to.length === 0) to = (orig.replyTo.length ? orig.replyTo : orig.from ? [orig.from] : []).map((a) => a.email);
    subject ??= /^re:/i.test(orig.subject) ? orig.subject : `Re: ${orig.subject}`;
    if (orig.messageId) {
      // Bridge exports each message's own Proton id as a "...@protonmail.internalid" reference.
      // On send, Bridge resolves the reply's parent from that id (more reliably than by Message-ID),
      // so it goes last; external ids keep the thread intact for the recipient.
      const isInternal = (r: string) => r.endsWith("@protonmail.internalid>");
      const references = [
        ...orig.references.filter((r) => !isInternal(r)),
        orig.messageId,
        ...orig.references.filter(isInternal),
      ];
      reply = { inReplyTo: orig.messageId, references };
      headers["In-Reply-To"] = reply.inReplyTo;
      headers["References"] = references.join(" ");
    }
  }
  if (to.length === 0) throw validationError("A draft needs at least one recipient", "Pass --to, or --reply-to <id>.");
  if (!subject) throw validationError("A draft needs a subject", "Pass --subject, or --reply-to <id>.");

  const messageId = `<${randomUUID()}@pmail.local>`;
  if (reply) rememberReply(messageId, reply.inReplyTo, reply.references);
  const raw = await new MailComposer({
    from: cfg.email,
    to,
    cc: input.cc,
    subject,
    text: input.body,
    messageId,
    headers,
  })
    .compile()
    .build();

  const drafts = await specialFolder(client, "\\Drafts");
  const res = await client.append(drafts, raw, ["\\Draft", "\\Seen"]);
  if (res && res.uid) return { id: formatId(drafts, res.uid) };

  // Server without UIDPLUS: find the draft by the Message-ID we generated.
  const lock = await client.getMailboxLock(drafts, { readOnly: true });
  try {
    const uids = (await client.search({ header: { "message-id": messageId } }, { uid: true })) || [];
    const uid = uids.at(-1);
    if (!uid) throw notFoundError("Draft was saved but could not be located in Drafts");
    return { id: formatId(drafts, uid) };
  } finally {
    lock.release();
  }
}

export async function draftSource(client: ImapFlow, id: string) {
  return fetchSource(client, id, false);
}

export async function deleteMessage(client: ImapFlow, id: string): Promise<void> {
  const { folder, uid } = parseId(id);
  const lock = await client.getMailboxLock(await resolveFolder(client, folder));
  try {
    await client.messageDelete(String(uid), { uid: true });
  } finally {
    lock.release();
  }
}
