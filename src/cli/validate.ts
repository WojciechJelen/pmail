import { validationError } from "../core/errors";

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
