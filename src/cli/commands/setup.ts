import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Command } from "commander";
import { configPath, defaultConfig, keychainAddCommand, loadCert, loadConfig, loadPassword, writeConfig } from "../../core/config";
import { ExitCode, PmailError, toPmailError, validationError } from "../../core/errors";
import { connectImap } from "../../core/imap";
import { verifySmtp } from "../../core/smtp";
import { emit, fail, run, type GlobalOpts } from "../output";
import { collectEmails } from "../validate";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
  hint?: string;
}

async function check(name: string, fn: () => Promise<string | undefined> | string | undefined): Promise<Check> {
  try {
    const detail = await fn();
    return { name, ok: true, ...(detail && { detail }) };
  } catch (err) {
    const e = toPmailError(err);
    return { name, ok: false, detail: e.message, ...(e.hint && { hint: e.hint }) };
  }
}

export function registerSetup(program: Command) {
  program
    .command("init")
    .description("Write ~/.config/pmail/config.json for Proton Mail Bridge (no network access)")
    .requiredOption("--email <address>", "Proton address Bridge uses as the IMAP/SMTP username", collectEmails("--email"))
    .option("--cert <path>", "Path of the exported Bridge TLS certificate (default ~/.config/pmail/cert.pem)")
    .option("--imap-port <n>", "Bridge IMAP port", "1143")
    .option("--smtp-port <n>", "Bridge SMTP port", "1025")
    .option("--force", "Overwrite an existing config")
    .addHelpText("after", "\nExample:\n  pmail init --email me@proton.me")
    .action((o, cmd: Command) => {
      const opts = cmd.optsWithGlobals<GlobalOpts>();
      return run(opts, async () => {
        if (existsSync(configPath()) && !o.force) {
          throw validationError(`Config already exists at ${configPath()}`, "Pass --force to overwrite it.");
        }
        const email = (o.email as string[])[0]!;
        const cfg = defaultConfig(email, o.cert);
        cfg.imap.port = Number(o.imapPort);
        cfg.smtp.port = Number(o.smtpPort);
        return {
          configPath: writeConfig(cfg),
          config: cfg,
          nextSteps: [
            `Export the TLS certificate from the Bridge app (Settings → Advanced settings → Export TLS certificates) to ${cfg.certPath}`,
            `Store the Bridge password (the one the Bridge app shows, not the Proton password): ${keychainAddCommand(email)}`,
            "Verify: pmail doctor",
          ],
        };
      });
    });

  program
    .command("doctor")
    .description("Check config, Keychain password, TLS certificate, and IMAP/SMTP login")
    .addHelpText("after", "\nExit code 0 when every check passes, 1 otherwise; failing checks carry a hint.\n\nExample:\n  pmail doctor")
    .action(async (_o, cmd: Command) => {
      const opts = cmd.optsWithGlobals<GlobalOpts>();
      try {
        const checks: Check[] = [];
        let cfg;
        try {
          cfg = loadConfig();
          checks.push({ name: "config", ok: true, detail: configPath() });
        } catch (err) {
          checks.push({ name: "config", ok: false, detail: (err as Error).message, hint: (err as PmailError).hint });
        }
        if (cfg) {
          const c = cfg;
          checks.push(await check("password", () => void loadPassword(c)));
          checks.push(
            await check("certificate", () => {
              loadCert(c);
              const cert = new X509Certificate(readFileSync(c.certPath));
              return `${cert.subject.replace(/\n/g, ", ")}; valid until ${cert.validTo}`;
            }),
          );
          if (checks.every((x) => x.ok)) {
            checks.push(
              await check("imap", async () => {
                const client = await connectImap(c);
                await client.logout();
                return `${c.imap.host}:${c.imap.port}`;
              }),
            );
            checks.push(
              await check("smtp", async () => {
                await verifySmtp(c);
                return `${c.smtp.host}:${c.smtp.port}`;
              }),
            );
          }
        }
        const ok = checks.every((x) => x.ok);
        emit({ ok, checks }, opts, (d) =>
          d.checks.map((x) => `${x.ok ? "✓" : "✗"} ${x.name.padEnd(12)} ${x.detail ?? ""}${x.hint ? `\n  hint: ${x.hint}` : ""}`).join("\n"),
        );
        process.exit(ok ? ExitCode.ok : ExitCode.general);
      } catch (err) {
        fail(err, opts);
      }
    });
}
