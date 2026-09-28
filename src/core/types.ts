export interface Address {
  name: string;
  email: string;
}

export interface Envelope {
  id: string;
  date: string | null;
  from: Address | null;
  to: Address[];
  subject: string;
  unread: boolean;
  starred: boolean;
  hasAttachments: boolean;
  size: number;
}

export interface AttachmentInfo {
  index: number;
  filename: string;
  contentType: string;
  size: number;
}

export interface Message {
  id: string;
  date: string | null;
  from: Address | null;
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  subject: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  unread: boolean;
  starred: boolean;
  body: string;
  bodyChars: number;
  truncated: boolean;
  attachments: AttachmentInfo[];
}

export interface Folder {
  path: string;
  specialUse: string | null;
  total: number;
  unread: number;
}

export interface EnvelopeQuery {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  since?: Date;
  before?: Date;
  unread?: boolean;
  starred?: boolean;
}

export interface OutgoingAttachment {
  filename: string;
  content: Buffer;
}

export interface DraftInput {
  to: string[];
  cc: string[];
  subject?: string;
  body: string;
  replyTo?: string;
  attachments?: OutgoingAttachment[];
}
