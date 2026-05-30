import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { CloudConnectionStatus } from "@/lib/bindings/CloudConnectionStatus";
import type { CloudService } from "@/lib/bindings/CloudService";
import type { QueueEntryView } from "@/lib/bindings/QueueEntryView";
import type { UploadStatus } from "@/lib/bindings/UploadStatus";
import { CLOUD_CONNECTION_KEY, CLOUD_QUEUE_KEY } from "./queryKey";

/** Human label for each Google service. */
const SERVICE_LABEL: Record<CloudService, string> = {
  "google-drive": "Google Drive",
  youtube: "YouTube",
  gmail: "Gmail",
};

/** Tailwind classes for each upload-status badge. */
const STATUS_BADGE: Record<UploadStatus, string> = {
  pending: "border-zinc-600 text-zinc-300",
  uploading: "border-sky-700 text-sky-300",
  failed: "border-red-800 text-red-300",
  "reauth-required": "border-amber-700 text-amber-300",
};

/**
 * Fase 6 cloud-backup panel. Shows which Google services are connected
 * (`cloud_connection_status`) with a disconnect action, and the durable upload
 * queue (`cloud_queue_status`) with per-entry retry/remove plus a "clear failed"
 * sweep. The OAuth connect flow and the upload worker (network I/O) are a
 * separate, deferred step — see `docs/PHASE6.md` — so "connect" is
 * shown as not-yet-available rather than as a dead button.
 *
 * Pure IPC + render; exercised in tests with `invoke` mocked.
 */
export function CloudBackupPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const conn = useQuery<CloudConnectionStatus[]>({
    queryKey: CLOUD_CONNECTION_KEY,
    queryFn: () => invoke<CloudConnectionStatus[]>("cloud_connection_status"),
  });

  const queue = useQuery<QueueEntryView[]>({
    queryKey: CLOUD_QUEUE_KEY,
    queryFn: () => invoke<QueueEntryView[]>("cloud_queue_status"),
  });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: CLOUD_CONNECTION_KEY });
    void queryClient.invalidateQueries({ queryKey: CLOUD_QUEUE_KEY });
  }, [queryClient]);

  const disconnectMutation = useMutation({
    mutationFn: (service: CloudService) =>
      invoke<void>("cloud_disconnect", { service }),
    onSuccess: invalidate,
  });
  const retryMutation = useMutation({
    mutationFn: (id: string) => invoke<void>("cloud_retry_upload", { id }),
    onSuccess: invalidate,
  });
  const removeMutation = useMutation({
    mutationFn: (id: string) => invoke<void>("cloud_remove_upload", { id }),
    onSuccess: invalidate,
  });
  const clearFailedMutation = useMutation({
    mutationFn: () => invoke<number>("cloud_clear_failed"),
    onSuccess: invalidate,
  });

  const onDisconnect = useCallback(
    (service: CloudService) => {
      if (
        window.confirm(
          t(
            "cloud.confirmDisconnect",
            "Koble fra denne tjenesten og fjerne dens køede opplastinger?",
          ),
        )
      ) {
        disconnectMutation.mutate(service);
      }
    },
    [disconnectMutation, t],
  );

  const statusLabel = useCallback(
    (status: UploadStatus): string => {
      switch (status) {
        case "pending":
          return t("cloud.statusPending", "Venter");
        case "uploading":
          return t("cloud.statusUploading", "Laster opp");
        case "failed":
          return t("cloud.statusFailed", "Feilet");
        case "reauth-required":
          return t("cloud.statusReauth", "Krever ny innlogging");
      }
    },
    [t],
  );

  const statuses = conn.data ?? [];
  const entries = queue.data ?? [];
  const hasFailed = entries.some((e) => e.status === "failed");

  return (
    <section
      className="flex w-full max-w-md flex-col gap-4"
      aria-label={t("cloud.title", "Sky-backup")}
    >
      {/* ── Connections ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">
          {t("cloud.connectionsTitle", "Tilkoblinger")}
        </h2>
        {conn.isError ? (
          <p className="text-red-400">
            {t("cloud.connError", "Kunne ikke lese tilkoblingsstatus")}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {statuses.map((s) => (
              <li
                key={s.service}
                className="flex items-center justify-between gap-3 rounded-lg border border-zinc-700 p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">
                    {SERVICE_LABEL[s.service]}
                  </span>
                  <span
                    className={`rounded border px-1.5 py-0.5 text-xs ${
                      s.connected
                        ? "border-emerald-700 text-emerald-300"
                        : "border-zinc-600 text-zinc-400"
                    }`}
                  >
                    {s.connected
                      ? t("cloud.connected", "Tilkoblet")
                      : t("cloud.disconnected", "Ikke tilkoblet")}
                  </span>
                </div>
                {s.connected ? (
                  <button
                    type="button"
                    className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
                    onClick={() => onDisconnect(s.service)}
                  >
                    {t("cloud.disconnect", "Koble fra")}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled
                    title={t(
                      "cloud.connectComingSoon",
                      "Tilkobling kommer snart",
                    )}
                    className="cursor-not-allowed rounded border border-zinc-800 px-2 py-1 text-xs opacity-50"
                  >
                    {t("cloud.connect", "Koble til")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Upload queue ────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">
            {t("cloud.queueTitle", "Opplastingskø")}
          </h2>
          {hasFailed && (
            <button
              type="button"
              className="rounded border border-red-800 px-2 py-1 text-xs text-red-300 hover:bg-red-950"
              onClick={() => clearFailedMutation.mutate()}
            >
              {t("cloud.clearFailed", "Fjern feilede")}
            </button>
          )}
        </div>
        {entries.length === 0 ? (
          <p className="opacity-60">
            {t("cloud.queueEmpty", "Ingen køede opplastinger")}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {entries.map((e) => (
              <li
                key={e.id}
                className="flex flex-col gap-1 rounded-lg border border-zinc-700 p-3 text-left"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium" title={e.filename}>
                      {e.filename}
                    </p>
                    <p className="text-xs opacity-70">
                      {SERVICE_LABEL[e.service]} ·{" "}
                      {t("cloud.attempts", "{{n}} forsøk", { n: e.attempts })}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded border px-1.5 py-0.5 text-xs ${STATUS_BADGE[e.status]}`}
                  >
                    {statusLabel(e.status)}
                  </span>
                </div>
                {e.lastError && (
                  <p
                    className="truncate text-xs text-red-400"
                    title={e.lastError}
                  >
                    {e.lastError}
                  </p>
                )}
                <div className="flex gap-2 self-end">
                  {(e.status === "failed" ||
                    e.status === "reauth-required") && (
                    <button
                      type="button"
                      className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
                      onClick={() => retryMutation.mutate(e.id)}
                    >
                      {t("cloud.retry", "Prøv igjen")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
                    onClick={() => removeMutation.mutate(e.id)}
                  >
                    {t("cloud.remove", "Fjern")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
