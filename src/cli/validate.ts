import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { validationError } from "../core/errors";
import type { OutgoingAttachment } from "../core/types";

export function parseLimit(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw validationError(`--limit must be an integer 1-100, got "${value}"`, "Use --before-id from the previous page to go further back.");
  }
  return n;
}

export function parseNonNegativeInt(flag: string) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw validationError(`${flag} must be a non-negative integer, got "${value}"`);
    return n;
  };
}

export function parseDate(flag: string) {
  return (value: string): Date => {
    const d = new Date(`${value}T00:00:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(d.getTime())) {
      throw validationError(`${flag} must be a date like 2026-09-01, got "${value}"`);
    }
    return d;
  };
}

const EMAIL = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;

// Repeatable and comma-separated: --to a@x.com --to b@y.com, or --to a@x.com,b@y.com
export function collectEmails(flag: string) {
  return (value: string, previous: string[] = []): string[] => {
    const emails = value.split(",").map((e) => e.trim()).filter(Boolean);
    const bad = emails.filter((e) => !EMAIL.test(e));
    if (bad.length) throw validationError(`${flag} has invalid address(es): ${bad.join(", ")}`, "Pass bare addresses like name@example.com.");
    return [...previous, ...emails];
  };
}

// Repeatable, never comma-split, since file names may contain commas: --attach a.pdf --attach b.png
export const collectPaths = (value: string, previous: string[] = []): string[] => [...previous, value];

// Proton rejects messages whose attachments exceed 25 MB in total; checking up front gives a clear error.
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function readAttachments(paths: string[]): OutgoingAttachment[] {
  const files = paths.map((path) => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      throw validationError(`--attach: file not found: ${path}`, "Pass a path to an existing file, relative to the current directory or absolute.");
    }
    if (!stat.isFile()) throw validationError(`--attach: not a regular file: ${path}`, "Attach files one at a time; zip a folder first.");
    return { path, size: stat.size };
  });
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_ATTACHMENT_BYTES) {
    const mb = (total / 1024 / 1024).toFixed(1);
    throw validationError(`Attachments total ${mb} MB; Proton allows 25 MB per message`, "Attach fewer or smaller files, or share a link instead.");
  }
  return files.map(({ path }) => ({ filename: basename(path), content: readFileSync(path) }));
}
