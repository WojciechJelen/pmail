export const ExitCode = {
  ok: 0,
  general: 1,
  auth: 2,
  validation: 3,
  confirmationRequired: 4,
  unreachable: 5,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class PmailError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string | undefined,
    readonly exitCode: ExitCodeValue,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PmailError";
  }
}

export const validationError = (message: string, hint?: string) =>
  new PmailError("E_VALIDATION", message, hint, ExitCode.validation);

export const notFoundError = (message: string, hint?: string) =>
  new PmailError("E_NOT_FOUND", message, hint, ExitCode.general);

const TLS_ERROR_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
]);

export function toPmailError(err: unknown, service: "IMAP" | "SMTP" = "IMAP"): PmailError {
  if (err instanceof PmailError) return err;
  const e = err as { code?: string; message?: string; authenticationFailed?: boolean; responseCode?: number };
  const message = e?.message ?? String(err);

  if (e?.code === "ECONNREFUSED" || e?.code === "ETIMEDOUT" || e?.code === "ECONNRESET") {
    return new PmailError(
      "E_UNREACHABLE",
      `${service} server not reachable: ${message}`,
      "Is Proton Mail Bridge running? Start it and retry.",
      ExitCode.unreachable,
    );
  }
  if (e?.authenticationFailed || e?.code === "EAUTH" || e?.responseCode === 535) {
    return new PmailError(
      "E_AUTH",
      `${service} login failed`,
      "The Keychain must hold the Bridge-generated password shown in the Bridge app, not the Proton account password. Ask the user to update it: security add-generic-password -U -s pmail-bridge -a <email> -w",
      ExitCode.auth,
    );
  }
  if (e?.code && TLS_ERROR_CODES.has(e.code)) {
    return new PmailError(
      "E_TLS",
      `TLS verification failed (${e.code})`,
      "Re-export the certificate from the Bridge app (Settings → Advanced settings → Export TLS certificates) to the certPath in the pmail config.",
      ExitCode.auth,
    );
  }
  return new PmailError("E_GENERAL", message, undefined, ExitCode.general);
}
