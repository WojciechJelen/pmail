import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import type { ConnectionOptions } from "node:tls";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ExitCode, PmailError } from "./errors";

export interface ServerConfig {
  host: string;
  port: number;
}

export interface Config {
  email: string;
  imap: ServerConfig;
  smtp: ServerConfig;
  certPath: string;
}

export const KEYCHAIN_SERVICE = "pmail-bridge";

export const configDir = () => join(homedir(), ".config", "pmail");
export const configPath = () => process.env.PMAIL_CONFIG ?? join(configDir(), "config.json");

export function defaultConfig(email: string, certPath = join(configDir(), "cert.pem")): Config {
  return {
    email,
    imap: { host: "127.0.0.1", port: 1143 },
    smtp: { host: "127.0.0.1", port: 1025 },
    certPath,
  };
}

const setupError = (message: string, hint: string) => new PmailError("E_SETUP", message, hint, ExitCode.auth);

export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) {
    throw setupError(`No config at ${path}`, "Run: pmail init --email you@proton.me");
  }
  const cfg = JSON.parse(readFileSync(path, "utf8")) as Config;
  if (!cfg.email || !cfg.imap?.port || !cfg.smtp?.port || !cfg.certPath) {
    throw setupError(`Config at ${path} is incomplete`, "Re-run: pmail init --email you@proton.me --force");
  }
  return cfg;
}

export function writeConfig(cfg: Config): string {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  return path;
}

export const keychainAddCommand = (email: string) =>
  `security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${email} -w`;

export function loadPassword(cfg: Config): string {
  if (process.env.PMAIL_PASSWORD) return process.env.PMAIL_PASSWORD;
  try {
    return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", cfg.email, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw setupError(
      `No Bridge password in Keychain (service "${KEYCHAIN_SERVICE}", account "${cfg.email}")`,
      `Ask the user to run this themselves (it prompts for the Bridge password): ${keychainAddCommand(cfg.email)}`,
    );
  }
}

// Bridge presents one self-signed cert. Instead of hostname matching (imapflow and nodemailer pass
// different server names for 127.0.0.1), require the server to present exactly the exported cert.
// Bun rejects an IP as SNI servername, so "localhost" is sent; identity comes from the pin, not the name.
export function tlsOptions(cfg: Config): ConnectionOptions {
  const ca = loadCert(cfg);
  const pinned = new X509Certificate(ca).fingerprint256;
  return {
    ca,
    servername: "localhost",
    checkServerIdentity: (_host, peer) =>
      peer.fingerprint256 === pinned
        ? undefined
        : new Error(`Server certificate ${peer.fingerprint256} does not match the pinned Bridge certificate ${pinned}`),
  };
}

export function loadCert(cfg: Config): string {
  if (!existsSync(cfg.certPath)) {
    throw setupError(
      `Bridge TLS certificate not found at ${cfg.certPath}`,
      `Export it from the Bridge app (Settings → Advanced settings → Export TLS certificates) and save the cert as ${cfg.certPath}`,
    );
  }
  return readFileSync(cfg.certPath, "utf8");
}
