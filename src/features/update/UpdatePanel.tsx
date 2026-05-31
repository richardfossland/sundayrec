import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { UpdateStatus } from "@/lib/bindings/UpdateStatus";
import { UPDATE_STATUS_KEY } from "./queryKey";

/** The `{ code, message }` shape an `AppError` serialises to over IPC. */
type IpcError = { code?: string; message?: string };

/** True when a command failed because the `updater` cargo feature is off — the
 *  default build returns `feature_disabled` so we show a calm hint, not a red
 *  error (mirrors the CloudBackupPanel / streaming "not built in" idiom). */
function isFeatureDisabled(err: unknown): boolean {
  const message = (err as IpcError)?.message ?? String(err ?? "");
  return message.includes("feature_disabled");
}

/**
 * R7 auto-update panel. Polls the live `update_status` and offers the
 * Electron-parity flow: "Se etter oppdateringer" → (if newer) "Last ned" →
 * (when ready) "Start på nytt og installer". The check/download/install path is
 * behind the default-off `updater` cargo feature; in the default build the
 * commands return `feature_disabled`, so the panel shows a "not built into this
 * build" hint instead of a dead button (the status still reads as `idle`).
 *
 * Pure IPC + render; exercised in tests with `invoke` mocked. The actual feed
 * fetch / signature verify / install are NETWORK/GUI-UNVERIFIED (need a signed
 * release — see docs/NEEDS-RICHARD.md).
 */
export function UpdatePanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const status = useQuery<UpdateStatus>({
    queryKey: UPDATE_STATUS_KEY,
    queryFn: () => invoke<UpdateStatus>("update_status"),
  });

  const setStatus = useCallback(
    (next: UpdateStatus) => queryClient.setQueryData(UPDATE_STATUS_KEY, next),
    [queryClient],
  );

  const checkMutation = useMutation({
    mutationFn: () => invoke<UpdateStatus>("update_check"),
    onSuccess: setStatus,
  });
  const downloadMutation = useMutation({
    mutationFn: () => invoke<UpdateStatus>("update_download_install"),
    onSuccess: setStatus,
  });
  const relaunchMutation = useMutation({
    mutationFn: () => invoke<void>("update_relaunch"),
  });

  // The combined "is the feature missing" flag from either action's last error.
  const featureMissing =
    isFeatureDisabled(checkMutation.error) ||
    isFeatureDisabled(downloadMutation.error);

  const phase = status.data?.phase ?? "idle";
  const version =
    status.data && "version" in status.data ? status.data.version : undefined;
  const percent =
    status.data && status.data.phase === "downloading"
      ? status.data.percent
      : 0;
  const errorMessage =
    status.data && status.data.phase === "error"
      ? status.data.message
      : undefined;

  // The human line for the current phase (Electron `update.*` catalog keys).
  const statusLine = useCallback((): string => {
    switch (phase) {
      case "idle":
        return t("update.checkHint", "Klikk «Se etter oppdateringer» for å sjekke");
      case "checking":
        return t("update.checking", "Sjekker etter oppdateringer…");
      case "upToDate":
        return t("update.upToDate", "Du er oppdatert");
      case "available":
        return t("update.available", "Ny versjon {v} er tilgjengelig — laster ned…").replace(
          "{v}",
          version ?? "",
        );
      case "downloading":
        return t("update.downloading", "Laster ned… {pct}%").replace(
          "{pct}",
          String(percent),
        );
      case "readyToInstall":
        return t(
          "update.readyInstall",
          "Versjon {v} er klar — start på nytt for å installere",
        ).replace("{v}", version ?? "");
      case "error":
        return errorMessage ?? t("update.error", "Kunne ikke sjekke for oppdateringer");
    }
  }, [phase, version, percent, errorMessage, t]);

  const checking = phase === "checking" || checkMutation.isPending;
  const downloading = phase === "downloading" || downloadMutation.isPending;

  return (
    <section
      className="flex w-full max-w-md flex-col gap-3"
      aria-label={t("general.updates", "Oppdateringer")}
    >
      <p className="text-sm opacity-80">{statusLine()}</p>

      {featureMissing && (
        <p className="rounded border border-zinc-700 bg-zinc-900 p-2 text-xs opacity-70">
          {t(
            "update.notBuilt",
            "Automatisk oppdatering er ikke bygget inn i denne versjonen.",
          )}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={checking}
          className="rounded border border-zinc-700 px-3 py-1 text-sm hover:bg-zinc-800 disabled:opacity-50"
          onClick={() => checkMutation.mutate()}
        >
          {t("general.checkNow", "Se etter oppdateringer")}
        </button>

        {phase === "available" && (
          <button
            type="button"
            disabled={downloading}
            className="rounded border border-sky-700 px-3 py-1 text-sm text-sky-300 hover:bg-zinc-800 disabled:opacity-50"
            onClick={() => downloadMutation.mutate()}
          >
            {t("update.downloadNow", "Last ned")}
          </button>
        )}

        {phase === "readyToInstall" && (
          <button
            type="button"
            className="rounded border border-emerald-700 px-3 py-1 text-sm text-emerald-300 hover:bg-zinc-800"
            onClick={() => relaunchMutation.mutate()}
          >
            {t("update.restartInstall", "↺ Start på nytt og installer")}
          </button>
        )}
      </div>
    </section>
  );
}
