import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { EmailStatus } from "@/lib/bindings/EmailStatus";
import type { EmailTransportKind } from "@/lib/bindings/EmailTransportKind";
import { EMAIL_STATUS_KEY } from "./queryKey";

/** True when an IPC rejection is the default-build "email feature off" error,
 *  so the panel shows a calm hint rather than a red error. The seam returns
 *  `feature_disabled: …` in the message of a `validation` AppError. */
function isFeatureDisabled(err: unknown): boolean {
  const msg = (err as { message?: string } | null)?.message ?? String(err);
  return msg.includes("feature_disabled");
}

/** True when the rejection is the "nothing configured" guard (blank recipient /
 *  missing SMTP fields / no Gmail token) — a different hint than feature-off. */
function isNoConfig(err: unknown): boolean {
  const msg = (err as { message?: string } | null)?.message ?? String(err);
  return msg.includes("no_config");
}

/**
 * PU-1 email-alerts panel. Configures the test-alert transport — a connected
 * Gmail account (no SMTP config) OR an SMTP server (host/port/user/pass/from) —
 * plus a recipient, and fires a localized "email works" test via
 * `email_send_test`. The send path is behind the default-off `email` cargo
 * feature, so in the default build the command returns `feature_disabled` and
 * the panel shows a calm "not built into this build" hint. `email_status`
 * (which works in every build) also reports this up-front + whether Gmail is
 * already connected, so the Gmail option is only offered when it's usable.
 *
 * The SMTP password is never persisted — it travels with the test request and
 * is dropped after the send (mirrors the Electron `mailer.ts` `sendTest`).
 *
 * Pure IPC + render; exercised in tests with `invoke` mocked.
 */
export function EmailSettingsPanel() {
  const { t, i18n } = useTranslation();

  const status = useQuery<EmailStatus>({
    queryKey: EMAIL_STATUS_KEY,
    queryFn: () => invoke<EmailStatus>("email_status"),
  });

  const gmailConnected = status.data?.gmailConnected ?? false;
  // Prefer the no-config Gmail path when it's available, else SMTP.
  const [transport, setTransport] = useState<EmailTransportKind | null>(null);
  const kind: EmailTransportKind =
    transport ?? (gmailConnected ? "gmail" : "smtp");

  const [recipient, setRecipient] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(587);
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [from, setFrom] = useState("");

  const [disabled, setDisabled] = useState(false);

  const testMutation = useMutation({
    mutationFn: () =>
      invoke<void>("email_send_test", {
        transport: kind,
        recipient: recipient.trim(),
        language: i18n.language,
        host: kind === "smtp" ? host.trim() : null,
        port: kind === "smtp" ? port : null,
        user: kind === "smtp" && user.trim() ? user.trim() : null,
        pass: kind === "smtp" ? pass : null,
        from: kind === "smtp" && from.trim() ? from.trim() : null,
      }),
    onError: (e) => setDisabled(isFeatureDisabled(e)),
  });

  const onTest = useCallback(() => {
    setDisabled(false);
    testMutation.mutate();
  }, [testMutation]);

  // The test is sendable when a recipient is present and, for SMTP, the
  // required server fields are filled (host + pass + from).
  const canTest =
    recipient.trim().length > 0 &&
    (kind === "gmail" ||
      (host.trim().length > 0 && pass.length > 0 && from.trim().length > 0));

  return (
    <section
      className="flex w-full max-w-md flex-col gap-4"
      aria-label={t("email.title", "E-postvarsler")}
    >
      {(disabled || status.data?.featureBuilt === false) && (
        <p className="rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-200">
          {t(
            "email.featureDisabled",
            "E-postvarsler er ikke bygd inn i denne versjonen. Innstillingene kan likevel lagres.",
          )}
        </p>
      )}

      {/* ── Transport ───────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm">
          {t("email.method", "Sendemetode")}
          <select
            className="rounded border border-zinc-700 bg-transparent px-2 py-1 text-sm"
            value={kind}
            onChange={(e) => setTransport(e.target.value as EmailTransportKind)}
            aria-label={t("email.method", "Sendemetode")}
          >
            <option value="gmail" disabled={!gmailConnected}>
              {gmailConnected
                ? t("email.methodGmail", "Gmail (tilkoblet)")
                : t("email.methodGmailOff", "Gmail (ikke tilkoblet)")}
            </option>
            <option value="smtp">{t("email.methodSmtp", "SMTP")}</option>
          </select>
        </label>
        {kind === "gmail" && !gmailConnected && (
          <p className="text-xs text-amber-400">
            {t(
              "email.gmailHint",
              "Koble til Google under Sky-backup for å sende via Gmail uten SMTP.",
            )}
          </p>
        )}
      </div>

      {/* ── SMTP fields ─────────────────────────────────────────────── */}
      {kind === "smtp" && (
        <div className="flex flex-col gap-2">
          <input
            className="rounded border border-zinc-700 bg-transparent px-2 py-1 text-sm"
            placeholder={t("email.smtpHost", "SMTP-tjener (f.eks. smtp.gmail.com)")}
            value={host}
            onChange={(e) => setHost(e.target.value)}
            aria-label={t("email.smtpHost", "SMTP-tjener (f.eks. smtp.gmail.com)")}
          />
          <label className="flex items-center gap-2 text-sm">
            {t("email.smtpPort", "Port")}
            <input
              type="number"
              className="w-24 rounded border border-zinc-700 bg-transparent px-2 py-1 text-sm"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              aria-label={t("email.smtpPort", "Port")}
            />
          </label>
          <input
            className="rounded border border-zinc-700 bg-transparent px-2 py-1 text-sm"
            placeholder={t("email.smtpUser", "Brukernavn (e-postadresse)")}
            value={user}
            onChange={(e) => setUser(e.target.value)}
            aria-label={t("email.smtpUser", "Brukernavn (e-postadresse)")}
          />
          <input
            type="password"
            className="rounded border border-zinc-700 bg-transparent px-2 py-1 text-sm"
            placeholder={t("email.smtpPass", "Passord / app-passord")}
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            aria-label={t("email.smtpPass", "Passord / app-passord")}
          />
          <input
            className="rounded border border-zinc-700 bg-transparent px-2 py-1 text-sm"
            placeholder={t("email.smtpFrom", "Avsender-adresse")}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            aria-label={t("email.smtpFrom", "Avsender-adresse")}
          />
        </div>
      )}

      {/* ── Recipient + test ────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <input
          type="email"
          className="rounded border border-zinc-700 bg-transparent px-2 py-1 text-sm"
          placeholder={t("email.recipient", "Mottaker (e-postadresse)")}
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          aria-label={t("email.recipient", "Mottaker (e-postadresse)")}
        />
        <button
          type="button"
          disabled={!canTest || testMutation.isPending}
          className="self-start rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
          onClick={onTest}
        >
          {t("email.sendTest", "Send testvarsel")}
        </button>

        {testMutation.isSuccess && (
          <p className="text-xs text-emerald-300" role="status">
            {t("email.testSent", "Testvarsel sendt.")}
          </p>
        )}
        {testMutation.isError && !disabled && (
          <p className="text-xs text-red-400" role="alert">
            {isNoConfig(testMutation.error)
              ? t("email.noConfig", "Fyll inn mottaker og e-postoppsett.")
              : t("email.testFailed", "Klarte ikke sende testvarsel.")}
          </p>
        )}
      </div>
    </section>
  );
}
