import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode, PmailError, toPmailError } from "../src/core/errors";
import { formatId, parseId } from "../src/core/ids";
import { toSearchObject } from "../src/core/imap";
import { normalizeSubject, truncate } from "../src/core/parse";
import { withReplyHeaders } from "../src/core/replies";
import { confirmationRequired } from "../src/core/smtp";
import { applyFields } from "../src/cli/output";
import { collectEmails, collectPaths, MAX_ATTACHMENT_BYTES, parseDate, parseLimit, readAttachments } from "../src/cli/validate";

describe("ids", () => {
  test("round-trips simple and nested folders", () => {
    expect(parseId(formatId("INBOX", 42))).toEqual({ folder: "INBOX", uid: 42 });
    expect(parseId("Folders/Work/7")).toEqual({ folder: "Folders/Work", uid: 7 });
  });

  test.each(["INBOX", "INBOX/", "/5", "INBOX/abc", "INBOX/0"])("rejects %p with a validation error", (id) => {
    expect(() => parseId(id)).toThrow(PmailError);
    try {
      parseId(id);
    } catch (e) {
      expect((e as PmailError).exitCode).toBe(ExitCode.validation);
    }
  });
});

describe("search query", () => {
  test("empty query matches all", () => {
    expect(toSearchObject({})).toEqual({ all: true });
  });

  test("maps flags to IMAP criteria", () => {
    const since = new Date("2026-09-01T00:00:00");
    expect(toSearchObject({ from: "alice", unread: true, starred: true, since })).toEqual({
      from: "alice",
      seen: false,
      flagged: true,
      since,
    });
  });
});

describe("parse helpers", () => {
  test("truncate reports whether it cut", () => {
    expect(truncate("hello", 10)).toEqual({ text: "hello", truncated: false });
    expect(truncate("hello", 3)).toEqual({ text: "hel", truncated: true });
    expect(truncate("hello", undefined)).toEqual({ text: "hello", truncated: false });
  });

  test("normalizeSubject strips reply/forward prefixes", () => {
    expect(normalizeSubject("Re: Fwd: RE: Lunch")).toBe("Lunch");
    expect(normalizeSubject("Lunch")).toBe("Lunch");
  });
});

describe("--fields", () => {
  const page = { folder: "INBOX", messages: [{ id: "INBOX/1", subject: "a", size: 9 }] };

  test("trims list items and keeps top-level keys", () => {
    expect(applyFields(page, "id,subject")).toEqual({ folder: "INBOX", messages: [{ id: "INBOX/1", subject: "a" }] });
  });

  test("trims a single object", () => {
    expect(applyFields({ id: "INBOX/1", body: "x", subject: "s" }, "id, body")).toEqual({ id: "INBOX/1", body: "x" });
  });

  test("a single message with address arrays is trimmed as an object, keeping the untrusted marker", () => {
    const msg = { untrusted: true, id: "INBOX/1", to: [{ name: "", email: "a@x.com" }], body: "secret" };
    expect(applyFields(msg, "id,to")).toEqual({ id: "INBOX/1", to: [{ name: "", email: "a@x.com" }], untrusted: true });
  });

  test("no-op without fields", () => {
    expect(applyFields(page, undefined)).toBe(page);
  });
});

describe("validation", () => {
  test("limit bounds", () => {
    expect(parseLimit("20")).toBe(20);
    expect(() => parseLimit("0")).toThrow(PmailError);
    expect(() => parseLimit("101")).toThrow(PmailError);
    expect(() => parseLimit("abc")).toThrow(PmailError);
  });

  test("dates must be YYYY-MM-DD", () => {
    expect(parseDate("--since")("2026-09-01").getDate()).toBe(1);
    expect(() => parseDate("--since")("09/01/2026")).toThrow(PmailError);
  });

  test("emails are collected across repeats and commas", () => {
    const collect = collectEmails("--to");
    expect(collect("b@y.com", collect("a@x.com, c@z.io"))).toEqual(["a@x.com", "c@z.io", "b@y.com"]);
    expect(() => collect("not-an-email")).toThrow(PmailError);
  });
});

describe("attachments", () => {
  const dir = mkdtempSync(join(tmpdir(), "pmail-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name: string, content: string | Buffer) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };
  const exitCodeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as PmailError).exitCode;
    }
  };

  test("paths are collected across repeats without splitting on commas", () => {
    expect(collectPaths("b.png", collectPaths("a, final.pdf"))).toEqual(["a, final.pdf", "b.png"]);
  });

  test("reads files, named by their basename", () => {
    const pdf = file("invoice.pdf", Buffer.from([0x25, 0x50, 0x44, 0x46]));
    expect(readAttachments([pdf, file("notes.txt", "hi")])).toEqual([
      { filename: "invoice.pdf", content: Buffer.from([0x25, 0x50, 0x44, 0x46]) },
      { filename: "notes.txt", content: Buffer.from("hi") },
    ]);
  });

  test("missing files and directories are invalid input", () => {
    expect(exitCodeOf(() => readAttachments([join(dir, "nope.pdf")]))).toBe(ExitCode.validation);
    expect(exitCodeOf(() => readAttachments([dir]))).toBe(ExitCode.validation);
  });

  test("rejects a total over Proton's 25 MB limit before reading anything", () => {
    const big = file("big.bin", "");
    truncateSync(big, MAX_ATTACHMENT_BYTES);
    expect(readAttachments([big])).toHaveLength(1);
    expect(exitCodeOf(() => readAttachments([big, file("one-more.txt", "x")]))).toBe(ExitCode.validation);
  });
});

describe("send confirmation gate", () => {
  test("carries preview and exact confirm command with exit code 4", () => {
    const err = confirmationRequired({
      draftId: "Drafts/12",
      to: [{ name: "", email: "a@x.com" }],
      cc: [],
      bcc: [],
      subject: "Hi",
      inReplyTo: null,
      body: "Hello",
      bodyTruncated: false,
      attachments: [],
    });
    expect(err.exitCode).toBe(ExitCode.confirmationRequired);
    expect(err.details?.confirmCommand).toBe("pmail send Drafts/12 --confirm");
  });
});

describe("error mapping", () => {
  test("connection refused → unreachable", () => {
    expect(toPmailError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })).exitCode).toBe(
      ExitCode.unreachable,
    );
  });

  test("auth failure → auth", () => {
    expect(toPmailError(Object.assign(new Error("fail"), { authenticationFailed: true })).exitCode).toBe(ExitCode.auth);
    expect(toPmailError(Object.assign(new Error("fail"), { code: "EAUTH" }), "SMTP").exitCode).toBe(ExitCode.auth);
  });

  test("self-signed cert → auth/setup with cert hint", () => {
    const e = toPmailError(Object.assign(new Error("self signed"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }));
    expect(e.code).toBe("E_TLS");
    expect(e.hint).toContain("Export TLS certificates");
  });
});

describe("reply headers", () => {
  test("replace existing In-Reply-To/References (incl. folded lines) and keep the body intact", () => {
    const src = Buffer.from(
      "From: a@x.com\r\nReferences: <own@protonmail.internalid>\r\n <more@x>\r\nSubject: Re: Hi\r\n\r\nbody\r\nReferences: not-a-header\r\n",
      "latin1",
    );
    const out = withReplyHeaders(src, { inReplyTo: "<orig@x>", references: ["<root@x>", "<orig@x>"] }).toString("latin1");
    expect(out).toBe(
      "From: a@x.com\r\nSubject: Re: Hi\r\nIn-Reply-To: <orig@x>\r\nReferences: <root@x> <orig@x>\r\n\r\nbody\r\nReferences: not-a-header\r\n",
    );
  });

  test("preserves non-UTF-8 bytes", () => {
    const src = Buffer.concat([Buffer.from("Subject: x\r\n\r\n"), Buffer.from([0xe9, 0xff])]);
    const out = withReplyHeaders(src, { inReplyTo: "<a@x>", references: ["<a@x>"] });
    expect(out.subarray(-2)).toEqual(Buffer.from([0xe9, 0xff]));
  });
});
