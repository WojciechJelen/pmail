import { writeFileSync } from "node:fs";
import type { Command } from "commander";
import { loadConfig } from "../../core/config";
import { listEnvelopes, listFolders, readAttachment, readMessage, readThread, withImap } from "../../core/imap";
import { DEFAULT_MAX_CHARS } from "../../core/parse";
import type { EnvelopeQuery } from "../../core/types";
import * as human from "../human";
import { run, type GlobalOpts } from "../output";
import { parseDate, parseLimit, parseNonNegativeInt } from "../validate";

// Every result that carries message content says so, so the agent treats it as data, not instructions.
const untrusted = <T extends object>(data: T) => ({ untrusted: true as const, ...data });

const examples = (...lines: string[]) => `\nExamples:\n${lines.map((l) => `  ${l}`).join("\n")}`;

function envelopeQuery(o: Record<string, unknown>): EnvelopeQuery {
  return {
    from: o.from as string | undefined,
    to: o.to as string | undefined,
    subject: o.subject as string | undefined,
    text: o.text as string | undefined,
    since: o.since as Date | undefined,
    before: o.before as Date | undefined,
    unread: o.unread as boolean | undefined,
    starred: o.starred as boolean | undefined,
  };
}

export function registerRead(program: Command) {
  program
    .command("folders")
    .description("List folders and labels with total and unread counts")
    .addHelpText("after", examples("pmail folders"))
    .action((_o, cmd: Command) =>
      run(cmd.optsWithGlobals<GlobalOpts>(), () => withImap(loadConfig(), async (c) => ({ folders: await listFolders(c) })), human.folders),
    );

  program
    .command("list")
    .description("List messages in a folder, newest first (does not mark anything as read)")
    .option("--folder <name>", "Folder path or special name (inbox, sent, archive, trash…)", "INBOX")
    .option("--unread", "Only unread messages")
    .option("--starred", "Only starred messages")
    .option("--limit <n>", "Messages per page (1-100)", parseLimit, 20)
    .option("--before-id <id>", "Continue from the nextBeforeId of a previous page")
    .addHelpText(
      "after",
      examples("pmail list --unread", "pmail list --folder archive --limit 50", "pmail list --before-id INBOX/4821 --fields id,from,subject"),
    )
    .action((o, cmd: Command) =>
      run(
        cmd.optsWithGlobals<GlobalOpts>(),
        async () => untrusted(await withImap(loadConfig(), (c) => listEnvelopes(c, o.folder, envelopeQuery(o), o.limit, o.beforeId))),
        human.envelopes,
      ),
    );

  program
    .command("search")
    .description("Search one folder; all criteria are combined with AND (case-insensitive substring match)")
    .option("--folder <name>", "Folder to search", "INBOX")
    .option("--from <text>", "Sender name or address contains")
    .option("--to <text>", "Recipient contains")
    .option("--subject <text>", "Subject contains")
    .option("--text <text>", "Headers or body contain")
    .option("--since <date>", "On or after YYYY-MM-DD", parseDate("--since"))
    .option("--before <date>", "Before YYYY-MM-DD", parseDate("--before"))
    .option("--unread", "Only unread messages")
    .option("--starred", "Only starred messages")
    .option("--limit <n>", "Messages per page (1-100)", parseLimit, 20)
    .option("--before-id <id>", "Continue from the nextBeforeId of a previous page")
    .addHelpText(
      "after",
      examples('pmail search --from alice@example.com --since 2026-09-01', 'pmail search --subject invoice --folder "All Mail"', 'pmail search --text "flight confirmation"'),
    )
    .action((o, cmd: Command) =>
      run(
        cmd.optsWithGlobals<GlobalOpts>(),
        async () => untrusted(await withImap(loadConfig(), (c) => listEnvelopes(c, o.folder, envelopeQuery(o), o.limit, o.beforeId))),
        human.envelopes,
      ),
    );

  program
    .command("read")
    .argument("<id>", 'Message id, e.g. "INBOX/4821"')
    .description("Read one message: headers, plain-text body, attachment list. Does not mark it as read unless --mark-read")
    .option("--max-chars <n>", "Truncate the body to this many characters", parseNonNegativeInt("--max-chars"), DEFAULT_MAX_CHARS)
    .option("--full", "Return the whole body, ignoring --max-chars")
    .option("--mark-read", "Also mark the message as read")
    .addHelpText("after", examples("pmail read INBOX/4821", "pmail read INBOX/4821 --full", "pmail read INBOX/4821 --fields from,subject,body"))
    .action((id: string, o, cmd: Command) =>
      run(
        cmd.optsWithGlobals<GlobalOpts>(),
        async () =>
          untrusted(
            await withImap(loadConfig(), (c) => readMessage(c, id, { maxChars: o.full ? undefined : o.maxChars, markRead: o.markRead })),
          ),
        human.message,
      ),
    );

  program
    .command("thread")
    .argument("<id>", "Any message id in the conversation")
    .description("List the messages of a conversation (its folder + Sent), oldest first, without bodies")
    .addHelpText("after", examples("pmail thread INBOX/4821"))
    .action((id: string, _o, cmd: Command) =>
      run(
        cmd.optsWithGlobals<GlobalOpts>(),
        async () => untrusted({ messages: await withImap(loadConfig(), (c) => readThread(c, id)) }),
        human.thread,
      ),
    );

  program
    .command("attachment")
    .argument("<id>", "Message id")
    .argument("<index>", "Attachment index from `pmail read`", parseNonNegativeInt("<index>"))
    .description("Save one attachment to a local file")
    .requiredOption("--out <path>", "Destination file path")
    .addHelpText("after", examples("pmail attachment INBOX/4821 0 --out ./invoice.pdf"))
    .action((id: string, index: number, o, cmd: Command) =>
      run(cmd.optsWithGlobals<GlobalOpts>(), async () => {
        const att = await withImap(loadConfig(), (c) => readAttachment(c, id, index));
        writeFileSync(o.out, att.content);
        return { saved: o.out as string, filename: att.filename, contentType: att.contentType, size: att.content.length };
      }),
    );
}
