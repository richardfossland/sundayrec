import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { Settings } from "@/lib/bindings/Settings";
import type { ScheduleSlot } from "@/lib/bindings/ScheduleSlot";
import type { SpecialRecording } from "@/lib/bindings/SpecialRecording";
import type { ScheduleStatus } from "@/lib/bindings/ScheduleStatus";
import { SETTINGS_QUERY_KEY } from "@/features/settings/queryKey";

const SCHEDULE_STATUS_KEY = ["scheduler_status"] as const;

/** Weekday order matches the backend convention: 0 = Monday … 6 = Sunday. */
const WEEKDAY_KEYS = [
  ["schedule.mon", "Ma"],
  ["schedule.tue", "Ti"],
  ["schedule.wed", "On"],
  ["schedule.thu", "To"],
  ["schedule.fri", "Fr"],
  ["schedule.sat", "Lø"],
  ["schedule.sun", "Sø"],
] as const;

const inputClass =
  "rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm";

function emptySlot(): ScheduleSlot {
  return { days: [6], start: "11:00", stop: "12:00", max: null };
}

function emptySpecial(): SpecialRecording {
  return {
    id: null,
    date: "",
    name: "",
    start: "11:00",
    stop: "12:00",
    deviceId: null,
  };
}

/** Render an ISO-like local datetime string (`YYYY-MM-DDTHH:MM:SS`) for display. */
function fmt(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The schedule vertical (Fase 5.1). Edits the weekly slots + dated specials in
 * `Settings`, persists them via `settings_save`, then pokes the backend
 * supervisor (`scheduler_reschedule`) so the new timers take effect at once.
 * Shows the computed next recording + the next 14 days from `scheduler_status`.
 */
export function SchedulePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data: settings } = useQuery<Settings>({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => invoke<Settings>("settings_get"),
  });

  const { data: status } = useQuery<ScheduleStatus>({
    queryKey: SCHEDULE_STATUS_KEY,
    queryFn: () => invoke<ScheduleStatus>("scheduler_status"),
  });

  const [slots, setSlots] = useState<ScheduleSlot[]>([]);
  const [specials, setSpecials] = useState<SpecialRecording[]>([]);

  // Seed the local editors from the persisted settings.
  useEffect(() => {
    if (settings) {
      setSlots(settings.slots ?? []);
      setSpecials(settings.specialRecordings ?? []);
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: async (next: {
      slots: ScheduleSlot[];
      specials: SpecialRecording[];
    }) => {
      if (!settings) return null;
      const updated: Settings = {
        ...settings,
        slots: next.slots,
        specialRecordings: next.specials,
      };
      const saved = await invoke<Settings>("settings_save", {
        settings: updated,
      });
      // Tell the supervisor to recompute its timers, and get fresh status back.
      const fresh = await invoke<ScheduleStatus>("scheduler_reschedule");
      return { saved, fresh };
    },
    onSuccess: (res) => {
      if (!res) return;
      queryClient.setQueryData(SETTINGS_QUERY_KEY, res.saved);
      queryClient.setQueryData(SCHEDULE_STATUS_KEY, res.fresh);
    },
  });

  const persist = useCallback(
    (nextSlots: ScheduleSlot[], nextSpecials: SpecialRecording[]) => {
      setSlots(nextSlots);
      setSpecials(nextSpecials);
      saveMutation.mutate({ slots: nextSlots, specials: nextSpecials });
    },
    [saveMutation],
  );

  const updateSlot = (i: number, patch: Partial<ScheduleSlot>) => {
    const next = slots.map((s, idx) => (idx === i ? { ...s, ...patch } : s));
    persist(next, specials);
  };
  const toggleDay = (i: number, day: number) => {
    const slot = slots[i];
    const has = slot.days.includes(day);
    const days = has
      ? slot.days.filter((d) => d !== day)
      : [...slot.days, day].sort((a, b) => a - b);
    updateSlot(i, { days });
  };

  const updateSpecial = (i: number, patch: Partial<SpecialRecording>) => {
    const next = specials.map((s, idx) => (idx === i ? { ...s, ...patch } : s));
    persist(slots, next);
  };

  return (
    <div className="flex flex-col gap-5 text-left" data-testid="schedule-page">
      {/* Next / upcoming summary */}
      <section className="rounded-lg border border-zinc-700 p-4">
        <h3 className="text-sm font-medium">
          {t("schedule.next", "Neste opptak")}
        </h3>
        <p className="mt-1 text-sm opacity-80" data-testid="next-recording">
          {status?.next
            ? fmt(status.next)
            : t("schedule.none", "Ingen planlagte opptak")}
        </p>
        {status && status.upcoming.length > 0 && (
          <ul className="mt-2 list-disc pl-5 text-xs opacity-70">
            {status.upcoming.slice(0, 5).map((u) => (
              <li key={u}>{fmt(u)}</li>
            ))}
          </ul>
        )}
      </section>

      {/* Weekly slots */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">
            {t("schedule.weekly", "Ukentlige opptak")}
          </h3>
          <button
            type="button"
            className="rounded border border-zinc-700 px-2 py-1 text-xs"
            onClick={() => persist([...slots, emptySlot()], specials)}
          >
            {t("schedule.addSlot", "Legg til")}
          </button>
        </div>

        {slots.length === 0 && (
          <p className="text-xs opacity-60">
            {t("schedule.noSlots", "Ingen ukentlige opptak ennå.")}
          </p>
        )}

        {slots.map((slot, i) => (
          <fieldset
            key={i}
            data-testid={`slot-${i}`}
            className="flex flex-col gap-2 rounded border border-zinc-700 p-3"
          >
            <div className="flex flex-wrap gap-1">
              {WEEKDAY_KEYS.map(([key, fallback], day) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={slot.days.includes(day)}
                  className={`h-7 w-8 rounded text-xs ${
                    slot.days.includes(day)
                      ? "bg-emerald-700"
                      : "border border-zinc-700"
                  }`}
                  onClick={() => toggleDay(i, day)}
                >
                  {t(key, fallback)}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="time"
                aria-label={t("schedule.start", "Start")}
                className={inputClass}
                value={slot.start}
                onChange={(e) => updateSlot(i, { start: e.target.value })}
              />
              <span className="opacity-60">–</span>
              <input
                type="time"
                aria-label={t("schedule.stop", "Stopp")}
                className={inputClass}
                value={slot.stop}
                onChange={(e) => updateSlot(i, { stop: e.target.value })}
              />
              <input
                type="number"
                min={0}
                aria-label={t("schedule.maxMinutes", "Maks minutter")}
                placeholder={t("schedule.maxMinutes", "Maks minutter")}
                className={`${inputClass} w-24`}
                value={slot.max ?? ""}
                onChange={(e) =>
                  updateSlot(i, {
                    max: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
              <button
                type="button"
                className="ml-auto text-xs text-red-400"
                onClick={() =>
                  persist(
                    slots.filter((_, idx) => idx !== i),
                    specials,
                  )
                }
              >
                {t("schedule.remove", "Fjern")}
              </button>
            </div>
          </fieldset>
        ))}
      </section>

      {/* Special (dated) recordings */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">
            {t("schedule.special", "Spesialopptak")}
          </h3>
          <button
            type="button"
            className="rounded border border-zinc-700 px-2 py-1 text-xs"
            onClick={() => persist(slots, [...specials, emptySpecial()])}
          >
            {t("schedule.addSpecial", "Legg til")}
          </button>
        </div>

        {specials.map((sp, i) => (
          <fieldset
            key={i}
            data-testid={`special-${i}`}
            className="flex flex-wrap items-center gap-2 rounded border border-zinc-700 p-3"
          >
            <input
              type="date"
              aria-label={t("schedule.date", "Dato")}
              className={inputClass}
              value={sp.date}
              onChange={(e) => updateSpecial(i, { date: e.target.value })}
            />
            <input
              type="text"
              aria-label={t("schedule.name", "Navn")}
              placeholder={t("schedule.name", "Navn")}
              className={`${inputClass} flex-1`}
              value={sp.name}
              onChange={(e) => updateSpecial(i, { name: e.target.value })}
            />
            <input
              type="time"
              aria-label={t("schedule.start", "Start")}
              className={inputClass}
              value={sp.start}
              onChange={(e) => updateSpecial(i, { start: e.target.value })}
            />
            <span className="opacity-60">–</span>
            <input
              type="time"
              aria-label={t("schedule.stop", "Stopp")}
              className={inputClass}
              value={sp.stop}
              onChange={(e) => updateSpecial(i, { stop: e.target.value })}
            />
            <button
              type="button"
              className="text-xs text-red-400"
              onClick={() =>
                persist(
                  slots,
                  specials.filter((_, idx) => idx !== i),
                )
              }
            >
              {t("schedule.remove", "Fjern")}
            </button>
          </fieldset>
        ))}
      </section>
    </div>
  );
}
