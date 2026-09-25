import { convert } from "html-to-text";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import type { FetchMessageObject, MessageAddressObject, MessageStructureObject } from "imapflow";
import { formatId } from "./ids";
import type { Address, Envelope, Message } from "./types";

export const DEFAULT_MAX_CHARS = 8000;

export const toAddress = (a: MessageAddressObject): Address => ({ name: a.name ?? "", email: a.address ?? "" });

function fromParsed(field: AddressObject | AddressObject[] | undefined): Address[] {
  if (!field) return [];
  const groups = Array.isArray(field) ? field : [field];
  return groups.flatMap((g) => g.value.map((v) => ({ name: v.name ?? "", email: v.address ?? "" })));
}

const toIso = (d: Date | string | undefined) => (d ? new Date(d).toISOString() : null);

function hasAttachment(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  if (node.disposition === "attachment") return true;
  return (node.childNodes ?? []).some(hasAttachment);
}

export function toEnvelope(folder: string, msg: FetchMessageObject): Envelope {
  const env = msg.envelope;
  const flags = msg.flags ?? new Set<string>();
  const from = env?.from?.[0];
  return {
    id: formatId(folder, msg.uid),
    date: toIso(env?.date ?? msg.internalDate),
    from: from ? toAddress(from) : null,
    to: (env?.to ?? []).map(toAddress),
    subject: env?.subject ?? "",
    unread: !flags.has("\\Seen"),
    starred: flags.has("\\Flagged"),
    hasAttachments: hasAttachment(msg.bodyStructure),
    size: msg.size ?? 0,
  };
}

export function truncate(text: string, maxChars: number | undefined): { text: string; truncated: boolean } {
  if (maxChars === undefined || text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

export function bodyText(parsed: ParsedMail): string {
  const text = parsed.text?.trim() || (parsed.html ? convert(parsed.html, { wordwrap: false }) : "");
  // Collapse runs of blank lines that HTML conversion and quoted replies leave behind.
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export async function parseSource(source: Buffer): Promise<ParsedMail> {
  return simpleParser(source, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
}

export function toMessage(
  folder: string,
  msg: FetchMessageObject,
  parsed: ParsedMail,
  maxChars: number | undefined,
): Message {
  const flags = msg.flags ?? new Set<string>();
  const full = bodyText(parsed);
  const { text, truncated } = truncate(full, maxChars);
  const references = parsed.references ?? [];
  return {
    id: formatId(folder, msg.uid),
    date: toIso(parsed.date ?? msg.internalDate),
    from: fromParsed(parsed.from)[0] ?? null,
    to: fromParsed(parsed.to),
    cc: fromParsed(parsed.cc),
    replyTo: fromParsed(parsed.replyTo),
    subject: parsed.subject ?? "",
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references: Array.isArray(references) ? references : [references],
    unread: !flags.has("\\Seen"),
    starred: flags.has("\\Flagged"),
    body: text,
    bodyChars: full.length,
    truncated,
    attachments: parsed.attachments.map((a, index) => ({
      index,
      filename: a.filename ?? `attachment-${index}`,
      contentType: a.contentType,
      size: a.size,
    })),
  };
}

export const normalizeSubject = (subject: string) => subject.replace(/^\s*((re|fwd?|aw|wg)\s*:\s*)+/i, "").trim();
