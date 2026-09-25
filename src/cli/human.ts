import type { EnvelopePage, ThreadEntry } from "../core/imap";
import type { Address, Folder, Message } from "../core/types";

const who = (a: Address | null) => (a ? a.name || a.email : "?");
const day = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") : "");
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export const folders = (data: { folders: Folder[] }) =>
  data.folders.map((f) => `${f.path.padEnd(28)} ${String(f.unread).padStart(5)} unread / ${f.total}`).join("\n");

export const envelopes = (page: EnvelopePage) => {
  const rows = page.messages.map(
    (m) =>
      `${m.unread ? "●" : " "} ${m.id.padEnd(18)} ${day(m.date)}  ${clip(who(m.from), 24).padEnd(24)}  ${clip(m.subject, 70)}`,
  );
  const more = page.nextBeforeId ? `\n… ${page.matched - page.messages.length} more (--before-id ${page.nextBeforeId})` : "";
  return (rows.join("\n") || "(no messages)") + more;
};

export const message = (m: Message) => {
  const list = (as: Address[]) => as.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ");
  const head = [
    `id:      ${m.id}`,
    `date:    ${day(m.date)}`,
    `from:    ${m.from ? list([m.from]) : ""}`,
    `to:      ${list(m.to)}`,
    ...(m.cc.length ? [`cc:      ${list(m.cc)}`] : []),
    `subject: ${m.subject}`,
    ...(m.attachments.length ? [`attach:  ${m.attachments.map((a) => `#${a.index} ${a.filename}`).join(", ")}`] : []),
  ];
  const tail = m.truncated ? `\n\n[truncated at ${m.body.length}/${m.bodyChars} chars — use --full]` : "";
  return `${head.join("\n")}\n\n${m.body}${tail}`;
};

export const thread = (data: { messages: ThreadEntry[] }) =>
  data.messages.map((m) => `${m.unread ? "●" : " "} ${m.id.padEnd(18)} ${day(m.date)}  ${clip(who(m.from), 24)}`).join("\n");
