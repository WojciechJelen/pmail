import nodemailer from "nodemailer";
import type { ImapFlow } from "imapflow";
import { loadPassword, tlsOptions, type Config } from "./config";
import { ExitCode, PmailError, toPmailError, validationError } from "./errors";
import { deleteMessage, draftSource } from "./imap";
import { bodyText, parseSource, truncate } from "./parse";
import { forgetReply, replyHeadersFor, withReplyHeaders } from "./replies";
import type { Address } from "./types";

export function createTransport(cfg: Config) {
  return nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: false,
    requireTLS: true,
    auth: { user: cfg.email, pass: loadPassword(cfg) },
    tls: tlsOptions(cfg),
    connectionTimeout: 10_000,
  });
}

export async function verifySmtp(cfg: Config): Promise<void> {
  const transport = createTransport(cfg);
  try {
    await transport.verify();
  } catch (err) {
    throw toPmailError(err, "SMTP");
  } finally {
    transport.close();
  }
}

export interface SendPreview {
  draftId: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  inReplyTo: string | null;
  body: string;
  bodyTruncated: boolean;
  attachments: string[];
}

export const PREVIEW_CHARS = 2000;

export function confirmationRequired(preview: SendPreview): PmailError {
  return new PmailError(
    "E_CONFIRMATION_REQUIRED",
    "Sending email requires explicit confirmation",
    "Show this preview to the user. Only after they approve this exact message, run confirmCommand.",
    ExitCode.confirmationRequired,
    { preview, confirmCommand: `pmail send ${preview.draftId} --confirm` },
  );
}

const addressList = (field: unknown): Address[] => {
  const groups = (Array.isArray(field) ? field : field ? [field] : []) as { value: { name?: string; address?: string }[] }[];
  return groups.flatMap((g) => g.value.map((v) => ({ name: v.name ?? "", email: v.address ?? "" })));
};

export async function sendDraft(
  client: ImapFlow,
  cfg: Config,
  draftId: string,
  confirm: boolean,
): Promise<{ sent: true; messageId: string | null; accepted: string[]; draftDeleted: boolean }> {
  const { msg, source } = await draftSource(client, draftId);
  if (!msg.flags?.has("\\Draft")) {
    throw validationError(`${draftId} is not a draft`, "Only messages created with `pmail draft` (or drafts in the Drafts folder) can be sent.");
  }
  const parsed = await parseSource(source);
  const [to, cc, bcc] = [addressList(parsed.to), addressList(parsed.cc), addressList(parsed.bcc)];
  const recipients = [...to, ...cc, ...bcc].map((a) => a.email).filter(Boolean);
  if (recipients.length === 0) throw validationError(`Draft ${draftId} has no recipients`);
  const reply = replyHeadersFor(parsed.messageId);

  if (!confirm) {
    const { text, truncated } = truncate(bodyText(parsed), PREVIEW_CHARS);
    throw confirmationRequired({
      draftId,
      to,
      cc,
      bcc,
      subject: parsed.subject ?? "",
      inReplyTo: reply?.inReplyTo ?? null,
      body: text,
      bodyTruncated: truncated,
      attachments: parsed.attachments.map((a) => a.filename ?? a.contentType),
    });
  }

  const transport = createTransport(cfg);
  let info;
  try {
    const raw = reply ? withReplyHeaders(source, reply) : source;
    info = await transport.sendMail({ envelope: { from: cfg.email, to: recipients }, raw });
  } catch (err) {
    throw toPmailError(err, "SMTP");
  } finally {
    transport.close();
  }

  // The message is already sent; a failed cleanup must not look like a failed send.
  if (parsed.messageId) forgetReply(parsed.messageId);
  let draftDeleted = true;
  await deleteMessage(client, draftId).catch(() => (draftDeleted = false));
  return {
    sent: true,
    messageId: parsed.messageId ?? null,
    accepted: (info.accepted ?? []).map(String),
    draftDeleted,
  };
}
