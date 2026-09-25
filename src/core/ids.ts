import { validationError } from "./errors";

export interface MessageRef {
  folder: string;
  uid: number;
}

export function formatId(folder: string, uid: number): string {
  return `${folder}/${uid}`;
}

// Folder paths can contain "/" (e.g. "Folders/Work"), so the UID is whatever follows the last slash.
export function parseId(id: string): MessageRef {
  const slash = id.lastIndexOf("/");
  const folder = id.slice(0, slash);
  const uidText = id.slice(slash + 1);
  const uid = Number(uidText);
  if (slash <= 0 || !/^\d+$/.test(uidText) || uid <= 0) {
    throw validationError(
      `Invalid message id "${id}"`,
      'Ids look like "INBOX/4821" (folder/uid). Get them from `pmail list` or `pmail search`.',
    );
  }
  return { folder, uid };
}
