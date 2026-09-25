import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { loadConfig } from "../../core/config";
import { validationError } from "../../core/errors";
import { createDraft, moveMessage, setFlags, withImap, type FlagChange } from "../../core/imap";
import { sendDraft } from "../../core/smtp";
import { run, type GlobalOpts } from "../output";
import { collectEmails } from "../validate";

const examples = (...lines: string[]) => `\nExamples:\n${lines.map((l) => `  ${l}`).join("\n")}`;

function readBody(o: { body?: string; bodyFile?: string }): string {
  if (o.body !== undefined && o.bodyFile !== undefined) throw validationError("Pass either --body or --body-file, not both");
  if (o.body !== undefined) return o.body;
  if (o.bodyFile !== undefined) return readFileSync(o.bodyFile === "-" ? 0 : o.bodyFile, "utf8");
  throw validationError("A draft needs a body", 'Pass --body "…", or --body-file <path> (use - for stdin).');
}

export function registerWrite(program: Command) {
  program
    .command("draft")
    .description("Save a plain-text draft to the Drafts folder. Never sends; use `pmail send` for that")
    .option("--to <addresses>", "Recipient(s); repeat or comma-separate. Defaults to the sender when --reply-to is set", collectEmails("--to"), [])
    .option("--cc <addresses>", "CC recipient(s); repeat or comma-separate", collectEmails("--cc"), [])
    .option("--subject <text>", 'Subject. Defaults to "Re: <original>" when --reply-to is set')
    .option("--body <text>", "Body text")
    .option("--body-file <path>", "Read the body from a file, or - for stdin")
    .option("--reply-to <id>", "Make this a reply to that message (threads it and fills to/subject)")
    .addHelpText(
      "after",
      examples(
        'pmail draft --reply-to INBOX/4821 --body "Thanks, Tuesday works."',
        'pmail draft --to alice@example.com --subject "Contract" --body-file ./reply.txt',
        "cat reply.txt | pmail draft --reply-to INBOX/4821 --body-file -",
      ),
    )
    .action((o, cmd: Command) =>
      run(cmd.optsWithGlobals<GlobalOpts>(), async () => {
        const body = readBody(o);
        const cfg = loadConfig();
        const { id } = await withImap(cfg, (c) =>
          createDraft(c, cfg, { to: o.to, cc: o.cc, subject: o.subject, body, replyTo: o.replyTo }),
        );
        return { draftId: id, next: `Show the draft to the user, then: pmail send ${id}` };
      }),
    );

  program
    .command("send")
    .argument("<draftId>", 'Draft id from `pmail draft`, e.g. "Drafts/12"')
    .description(
      "Send a draft. Without --confirm it sends nothing: it exits 4 and prints a preview plus the confirm command",
    )
    .option("--confirm", "Actually send. Only after the user approved this exact message")
    .addHelpText("after", examples("pmail send Drafts/12            # preview, exit code 4", "pmail send Drafts/12 --confirm  # sends"))
    .action((draftId: string, o, cmd: Command) =>
      run(cmd.optsWithGlobals<GlobalOpts>(), async () => {
        const cfg = loadConfig();
        return withImap(cfg, (c) => sendDraft(c, cfg, draftId, Boolean(o.confirm)));
      }),
    );

  program
    .command("move")
    .argument("<id>", "Message id")
    .description('Move a message to another folder. "Deleting" = --to trash (no permanent delete)')
    .requiredOption("--to <folder>", "Destination folder path or special name (archive, trash, spam, inbox)")
    .addHelpText("after", examples("pmail move INBOX/4821 --to archive", 'pmail move INBOX/4821 --to "Folders/Receipts"'))
    .action((id: string, o, cmd: Command) =>
      run(cmd.optsWithGlobals<GlobalOpts>(), () => withImap(loadConfig(), (c) => moveMessage(c, id, o.to))),
    );

  program
    .command("flag")
    .argument("<id>", "Message id")
    .description("Mark a message read/unread and/or starred/unstarred")
    .option("--read", "Mark as read")
    .option("--unread", "Mark as unread")
    .option("--star", "Star it")
    .option("--unstar", "Remove the star")
    .addHelpText("after", examples("pmail flag INBOX/4821 --read", "pmail flag INBOX/4821 --star --unread"))
    .action((id: string, o, cmd: Command) =>
      run(cmd.optsWithGlobals<GlobalOpts>(), async () => {
        if (o.read && o.unread) throw validationError("--read and --unread are mutually exclusive");
        if (o.star && o.unstar) throw validationError("--star and --unstar are mutually exclusive");
        const change: FlagChange = {};
        if (o.read || o.unread) change.read = Boolean(o.read);
        if (o.star || o.unstar) change.starred = Boolean(o.star);
        if (Object.keys(change).length === 0) throw validationError("Nothing to change", "Pass --read, --unread, --star or --unstar.");
        await withImap(loadConfig(), (c) => setFlags(c, id, change));
        return { id, ...change };
      }),
    );
}
