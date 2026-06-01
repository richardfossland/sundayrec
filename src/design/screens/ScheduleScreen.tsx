/**
 * Tidsplan — recurring-recording calendar. Ported from `sr-schedule-live.jsx`.
 * Month grid, weekly schedule list, and the collapsible "wake from sleep"
 * panel. Data-driven from the existing IPC contract (`settings_get`,
 * `scheduler_status`, `wake_capabilities`) using the same query keys as the
 * legacy `SchedulePage`/`WakePanel`, with sample/empty-state fallbacks so dev
 * and test runs (where the commands error) never crash.
 */
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Icon } from "../Icon";
import { Badge, Card } from "../atoms";
import {
  MONTH_NAMES,
  buildMonthEvents,
  buildWeeksFor,
  emptySlot,
  emptySpecial,
  formatNextRecording,
  formatSpecialDate,
  isoDate,
  mergeFeastEvents,
  nextOccurrence,
  slotDayLabel,
  slotTimeRange,
  type DayEvent,
} from "./schedule.helpers";
import {
  WAKE_LEAD_MINUTES,
  confidenceLevel,
  startTime as confidenceStartTime,
  timeUntil,
  wakeTime,
  type TimeUntil,
} from "./schedule.confidence";
import { SETTINGS_QUERY_KEY } from "@/features/settings/queryKey";
import type { Settings } from "@/lib/bindings/Settings";
import type { ScheduleStatus } from "@/lib/bindings/ScheduleStatus";
import type { ScheduleSlot } from "@/lib/bindings/ScheduleSlot";
import type { SpecialRecording } from "@/lib/bindings/SpecialRecording";
import type { WakeCapabilities } from "@/lib/bindings/WakeCapabilities";
import type { LiturgicalDay } from "@/lib/bindings/LiturgicalDay";

const SCHEDULER_STATUS_KEY = ["scheduler_status"] as const;

/* ── Sample fallback (May 2026) used when live data is unavailable ──────── */
type EvKind = DayEvent["k"];
const SAMPLE_EVENTS: Record<number, { t: string; k: EvKind }[]> = {
  1: [{ t: "Arbeidernes dag", k: "hoy" }],
  3: [{ t: "Ukentlig", k: "uke" }],
  10: [{ t: "Ukentlig", k: "uke" }],
  14: [{ t: "Kristi himmelfartsdag", k: "hoy" }],
  17: [
    { t: "17. mai", k: "hoy" },
    { t: "Ukentlig", k: "uke" },
  ],
  24: [
    { t: "Første pinsedag", k: "hoy" },
    { t: "Ukentlig", k: "uke" },
  ],
  25: [{ t: "Andre pinsedag", k: "hoy" }],
  31: [{ t: "Ukentlig", k: "uke" }],
};

function buildSampleWeeks(): (number | null)[][] {
  // Mai 2026 — 1. mai = fredag. Monday-first grid.
  const weeks: (number | null)[][] = [[null, null, null, null, 1, 2, 3]];
  let d = 4;
  while (d <= 31) {
    const w: (number | null)[] = [];
    for (let i = 0; i < 7 && d <= 31; i++) w.push(d++);
    while (w.length < 7) w.push(null);
    weeks.push(w);
  }
  return weeks;
}

const EV_COLORS: Record<EvKind, { bg: string; fg: string; dot?: string }> = {
  uke: {
    bg: "var(--sr-gold-tint)",
    fg: "var(--sr-gold-bright)",
    dot: "var(--sr-gold)",
  },
  spes: { bg: "var(--sr-red-tint)", fg: "var(--sr-red)", dot: "var(--sr-red)" },
  hoy: { bg: "var(--sr-blue-tint)", fg: "#9CC4E8" },
};

function CalCell({
  day,
  events,
  today,
  onClick,
}: {
  day: number | null;
  events: { t: string; k: EvKind }[];
  today: boolean;
  onClick?: () => void;
}) {
  const { t } = useTranslation();
  const evs = day ? events : [];
  const clickable = day != null && onClick != null;
  return (
    <div
      onClick={clickable ? onClick : undefined}
      title={
        clickable
          ? t("scheduleScreen.addSpecialTitle", "Legg til spesialopptak")
          : undefined
      }
      style={{
        minHeight: 86,
        padding: 8,
        borderRight: "1px solid var(--sr-line)",
        borderBottom: "1px solid var(--sr-line)",
        background: day ? "transparent" : "rgba(0,0,0,0.12)",
        cursor: clickable ? "pointer" : "default",
      }}
    >
      {day && (
        <div
          className="sr-num"
          style={{
            fontSize: 13,
            fontWeight: 600,
            marginBottom: 6,
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <span
            style={
              today
                ? {
                    background: "var(--sr-gold)",
                    color: "#1A1306",
                    width: 24,
                    height: 24,
                    borderRadius: "50%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }
                : { color: "var(--sr-text-2)" }
            }
          >
            {day}
          </span>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {evs.map((e, i) => {
          const c = EV_COLORS[e.k];
          return (
            <div
              key={i}
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "2px 7px",
                borderRadius: 5,
                lineHeight: 1.3,
                display: "flex",
                alignItems: "center",
                gap: 5,
                background: c.bg,
                color: c.fg,
              }}
            >
              {c.dot && (
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: "50%",
                    background: c.dot,
                  }}
                />
              )}
              {e.t}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── "Vil maskinen ta opp?" confidence panel ────────────────────────────────
   The reassuring banner a volunteer scans first: WHEN the next recording is
   (in plain language) and WHETHER the Mac will wake itself to do it. All facts
   come from data the renderer already holds — no new backend. */
function humanizeUntil(
  tu: TimeUntil | null,
  t: (k: string, d: string, o?: Record<string, unknown>) => string,
): string | null {
  if (!tu) return null;
  switch (tu.unit) {
    case "days":
      return t("scheduleScreen.confidence.inDays", "om {{count}} dager", {
        count: tu.value,
      });
    case "hours":
      return t("scheduleScreen.confidence.inHours", "om {{count}} timer", {
        count: tu.value,
      });
    case "minutes":
      return t("scheduleScreen.confidence.inMinutes", "om {{count}} min", {
        count: tu.value,
      });
    case "now":
      return t("scheduleScreen.confidence.now", "nå");
    case "past":
      return null;
  }
}

/** A friendly "søndag 1. juni, 11:00" for the next-recording line. */
function longWhen(nextIso: string | null | undefined): string | null {
  if (!nextIso) return null;
  const d = new Date(nextIso);
  if (Number.isNaN(d.getTime())) return formatNextRecording(nextIso);
  const date = d.toLocaleDateString("nb-NO", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const time = d.toLocaleTimeString("nb-NO", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${date}, ${time}`;
}

function ConfidencePanel({
  nextIso,
  upcoming,
  wakeEnabled,
  canWake,
  haveLive,
  onEnableWake,
  enabling,
}: {
  nextIso: string | null | undefined;
  upcoming: string[] | undefined;
  wakeEnabled: boolean;
  canWake: boolean;
  haveLive: boolean;
  onEnableWake: () => void;
  enabling: boolean;
}) {
  const { t } = useTranslation();
  const level = confidenceLevel({ nextIso, wakeEnabled, canWake });

  const chip =
    level === "ready"
      ? {
          kind: "ok" as const,
          icon: "check" as const,
          text: t(
            "scheduleScreen.confidence.chipReady",
            "Klart til å ta opp automatisk",
          ),
        }
      : level === "needsOn"
        ? {
            kind: "warn" as const,
            icon: "warn" as const,
            text: t(
              "scheduleScreen.confidence.chipNeedsOn",
              "Krever at maskinen står på",
            ),
          }
        : {
            kind: "muted" as const,
            icon: "calendar" as const,
            text: t(
              "scheduleScreen.confidence.chipNone",
              "Ingen planlagte opptak",
            ),
          };

  const when = longWhen(nextIso);
  const until = humanizeUntil(timeUntil(nextIso), t);
  const wakeAt = wakeTime(nextIso);
  const recAt = confidenceStartTime(nextIso);

  // Up to three upcoming recordings (the next is shown in the headline already,
  // so list the following ones). Falls back gracefully when status is absent.
  const nextList = (upcoming ?? [])
    .filter((iso) => iso !== nextIso)
    .slice(0, 3)
    .map((iso) => ({ iso, label: longWhen(iso) }))
    .filter((x) => x.label != null);

  const accent =
    level === "ready"
      ? "var(--sr-green)"
      : level === "needsOn"
        ? "var(--sr-gold-bright)"
        : "var(--sr-text-3)";
  const bg =
    level === "ready"
      ? "var(--sr-green-tint)"
      : level === "needsOn"
        ? "var(--sr-gold-tint)"
        : "var(--sr-ink-750)";
  const border =
    level === "ready"
      ? "var(--sr-green)"
      : level === "needsOn"
        ? "var(--sr-gold-line)"
        : "var(--sr-line)";

  return (
    <div
      className="sr-card"
      data-testid="confidence-panel"
      style={{
        padding: 18,
        marginBottom: 16,
        background: bg,
        borderColor: border,
      }}
    >
      <div className="sr-row" style={{ alignItems: "flex-start", gap: 16 }}>
        <div className="sr-grow">
          {/* Big status chip */}
          <span
            className="sr-row"
            style={{
              gap: 8,
              padding: "7px 14px",
              borderRadius: 999,
              fontSize: 14,
              fontWeight: 700,
              background: "rgba(0,0,0,0.18)",
              color: accent,
            }}
          >
            <Icon name={chip.icon} size={16} />
            {chip.text}
          </span>

          {/* Next recording, in plain language */}
          <div style={{ marginTop: 14 }}>
            <div
              className="sr-label"
              style={{ marginBottom: 3, textTransform: "none" }}
            >
              {t("scheduleScreen.confidence.nextLabel", "Neste opptak")}
            </div>
            {when ? (
              <div style={{ fontSize: 17, fontWeight: 650 }}>
                {when}
                {until && (
                  <span
                    style={{
                      color: "var(--sr-text-3)",
                      fontWeight: 500,
                      marginLeft: 8,
                    }}
                  >
                    — {until}
                  </span>
                )}
              </div>
            ) : (
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 600,
                  color: "var(--sr-text-2)",
                }}
              >
                {t(
                  "scheduleScreen.confidence.nextNone",
                  "Ingen planlagte opptak",
                )}
              </div>
            )}
          </div>

          {/* Wake-confidence line */}
          {nextIso && (
            <div
              className="sr-row"
              style={{ marginTop: 12, gap: 8, alignItems: "flex-start" }}
            >
              <Icon
                name={level === "ready" ? "check" : "warn"}
                size={16}
                style={{ color: accent, marginTop: 2, flex: "0 0 auto" }}
              />
              <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>
                {level === "ready" ? (
                  <span>
                    {t(
                      "scheduleScreen.confidence.wakeReady",
                      "Maskinen vil våkne automatisk kl. {{wakeAt}} og starte opptaket {{recAt}}.",
                      { wakeAt: wakeAt ?? "", recAt: recAt ?? "" },
                    )}
                  </span>
                ) : (
                  <span>
                    <span
                      style={{
                        color: "var(--sr-gold-bright)",
                        fontWeight: 600,
                      }}
                    >
                      {t(
                        "scheduleScreen.confidence.wakeNeedsOn",
                        "Maskinen må stå PÅ (ikke i dvale) for at opptaket skal starte.",
                      )}
                    </span>{" "}
                    {canWake
                      ? t(
                          "scheduleScreen.confidence.wakeCaveatCan",
                          "Slå på automatisk vekking, og la maskinen være koblet til strøm og kun i dvale (ikke helt avslått). Lokket kan være lukket.",
                        )
                      : t(
                          "scheduleScreen.confidence.wakeCaveatCannot",
                          "Denne maskinen kan ikke vekkes automatisk. La den stå på og koblet til strøm fram til opptaket.",
                        )}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Lead-time note + enable button */}
          <div
            className="sr-row"
            style={{ marginTop: 12, gap: 12, flexWrap: "wrap" }}
          >
            {level === "ready" && (
              <span style={{ fontSize: 12.5, color: "var(--sr-text-3)" }}>
                {t(
                  "scheduleScreen.confidence.leadNote",
                  "Våkner {{lead}} min før hvert opptak.",
                  { lead: WAKE_LEAD_MINUTES },
                )}
              </span>
            )}
            {level === "needsOn" && canWake && nextIso && (
              <button
                className="sr-btn gold sm"
                onClick={onEnableWake}
                disabled={!haveLive || enabling}
                data-testid="enable-wake"
              >
                <Icon name="power" size={14} />
                {enabling
                  ? t("scheduleScreen.confidence.enabling", "Slår på…")
                  : t(
                      "scheduleScreen.confidence.enableWake",
                      "Slå på automatisk vekking",
                    )}
              </button>
            )}
          </div>
        </div>

        {/* Upcoming list */}
        {nextList.length > 0 && (
          <div
            style={{
              flex: "0 0 220px",
              borderLeft: "1px solid var(--sr-line)",
              paddingLeft: 16,
            }}
          >
            <div
              className="sr-label"
              style={{ marginBottom: 8, textTransform: "none" }}
            >
              {t("scheduleScreen.confidence.thenLabel", "Deretter")}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {nextList.map((u) => (
                <div
                  key={u.iso}
                  className="sr-row"
                  style={{ gap: 8, fontSize: 12.5, color: "var(--sr-text-2)" }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "var(--sr-gold)",
                      flex: "0 0 auto",
                    }}
                  />
                  {u.label}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function ScheduleScreen() {
  const { t } = useTranslation();
  const dows = [
    t("scheduleScreen.dowMon", "Man"),
    t("scheduleScreen.dowTue", "Tir"),
    t("scheduleScreen.dowWed", "Ons"),
    t("scheduleScreen.dowThu", "Tor"),
    t("scheduleScreen.dowFri", "Fre"),
    t("scheduleScreen.dowSat", "Lør"),
    t("scheduleScreen.dowSun", "Søn"),
  ];
  const queryClient = useQueryClient();

  // Live data — same query keys as SchedulePage / WakePanel so the cache is
  // shared. All three tolerate IPC errors: `data` stays undefined → fallbacks.
  const { data: settings } = useQuery<Settings>({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => invoke<Settings>("settings_get"),
  });
  const { data: status } = useQuery<ScheduleStatus>({
    queryKey: SCHEDULER_STATUS_KEY,
    queryFn: () => invoke<ScheduleStatus>("scheduler_status"),
  });
  const { data: caps } = useQuery<WakeCapabilities>({
    queryKey: ["wake_capabilities"],
    queryFn: () => invoke<WakeCapabilities>("wake_capabilities"),
  });

  const slots: ScheduleSlot[] = settings?.slots ?? [];
  const specials: SpecialRecording[] = settings?.specialRecordings ?? [];
  const upcoming = status?.upcoming;
  const nextRecording = status?.next ?? null;
  // `canWakeFromSleep` = the HOST is physically capable; `wakeFromSleep` = the
  // user has turned the feature on. Both must hold for "will record" confidence.
  const canWake = caps?.canWakeFromSleep ?? false;
  const wakeEnabled = settings?.wakeFromSleep ?? false;
  // The collapsible wake-card badge reflects the HOST's capability (unchanged).
  const wakeActive = canWake;
  const haveLive = settings != null;

  /* ── Enable wake-from-sleep from the confidence panel ───────────────────
     Persist `wakeFromSleep = true` into Settings, then ask the wake backend to
     (re)register the OS wake timers now. Both steps are guarded so dev/test
     (where IPC errors) simply no-op. */
  const enableWakeMutation = useMutation({
    mutationFn: async () => {
      if (!settings) return null;
      const updated: Settings = { ...settings, wakeFromSleep: true };
      const saved = await invoke<Settings>("settings_save", {
        settings: updated,
      });
      try {
        await invoke("wake_reschedule");
      } catch {
        // Reschedule may prompt/fail; the setting is persisted regardless.
      }
      return saved;
    },
    onSuccess: (saved) => {
      if (saved) queryClient.setQueryData(SETTINGS_QUERY_KEY, saved);
    },
  });

  /* ── Persistence (mirrors features/schedule/SchedulePage) ───────────────
     Save the updated slots/specials into Settings via `settings_save`, then
     poke the supervisor via `scheduler_reschedule`. Every step is guarded so a
     missing/erroring backend (dev/test) simply no-ops and the live or sample
     month still renders. */
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
      let fresh: ScheduleStatus | null;
      try {
        fresh = await invoke<ScheduleStatus>("scheduler_reschedule");
      } catch {
        // Reschedule can fail in dev/test; settings still persisted above.
        fresh = null;
      }
      return { saved, fresh };
    },
    onSuccess: (res) => {
      if (!res) return;
      queryClient.setQueryData(SETTINGS_QUERY_KEY, res.saved);
      if (res.fresh) queryClient.setQueryData(SCHEDULER_STATUS_KEY, res.fresh);
      void queryClient.invalidateQueries({ queryKey: SCHEDULER_STATUS_KEY });
    },
  });

  const persist = (
    nextSlots: ScheduleSlot[],
    nextSpecials: SpecialRecording[],
  ) => {
    // No live settings yet → nothing to persist against; stay graceful.
    if (!haveLive) return;
    saveMutation.mutate({ slots: nextSlots, specials: nextSpecials });
  };

  /* ── Slot editing ───────────────────────────────────────────────────── */
  const [editingSlot, setEditingSlot] = useState<number | null>(null);

  const updateSlot = (i: number, patch: Partial<ScheduleSlot>) => {
    persist(
      slots.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
      specials,
    );
  };
  const toggleSlotDay = (i: number, day: number) => {
    const slot = slots[i];
    if (!slot) return;
    const has = slot.days.includes(day);
    const days = has
      ? slot.days.filter((d) => d !== day)
      : [...slot.days, day].sort((a, b) => a - b);
    updateSlot(i, { days });
  };
  const removeSlot = (i: number) => {
    setEditingSlot(null);
    persist(
      slots.filter((_, idx) => idx !== i),
      specials,
    );
  };
  const addSlot = () => {
    persist([...slots, emptySlot()], specials);
    // Open the editor on the freshly appended slot.
    setEditingSlot(slots.length);
  };

  /* ── Special-recording editing ──────────────────────────────────────── */
  const [draftSpecial, setDraftSpecial] = useState<SpecialRecording | null>(
    null,
  );

  const openSpecialEditor = (date = "") => setDraftSpecial(emptySpecial(date));
  const saveDraftSpecial = () => {
    if (!draftSpecial || !draftSpecial.date) return;
    persist(slots, [...specials, draftSpecial]);
    setDraftSpecial(null);
  };
  const removeSpecial = (i: number) => {
    persist(
      slots,
      specials.filter((_, idx) => idx !== i),
    );
  };

  // Calendar: drive the current month from real data when available, else the
  // original Mai 2026 sample month. Month/year are local state so the prev/next
  // chevrons and "I dag" can navigate.
  const realNow = new Date();
  const [view, setView] = useState<{ year: number; month: number }>({
    year: realNow.getFullYear(),
    month: realNow.getMonth(),
  });
  const year = haveLive ? view.year : realNow.getFullYear();
  const month = haveLive ? view.month : realNow.getMonth();

  // "Kirkehøytider" toggle: when on, fetch the displayed month's liturgical
  // feast days and merge them into the calendar as blue "hoy" pills. Keyed on
  // the displayed (year, month) so paging refetches; errors/empty → no pills.
  const [showHolidays, setShowHolidays] = useState(false);
  const { data: feasts } = useQuery<LiturgicalDay[]>({
    queryKey: ["liturgical_month", year, month],
    queryFn: () =>
      invoke<LiturgicalDay[]>("liturgical_month", {
        year,
        // Backend month is 1-based; `month` is 0-based (Date.getMonth()).
        month: month + 1,
      }),
    enabled: showHolidays,
  });
  const todayDate = realNow.getDate();
  const viewingThisMonth =
    year === realNow.getFullYear() && month === realNow.getMonth();

  const goMonth = (delta: number) => {
    setView((v) => {
      const d = new Date(v.year, v.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  };
  const goToday = () =>
    setView({ year: realNow.getFullYear(), month: realNow.getMonth() });

  const liveWeeks = haveLive ? buildWeeksFor(year, month) : null;
  const liveEvents = haveLive
    ? mergeFeastEvents(
        buildMonthEvents(year, month, slots, specials),
        showHolidays ? feasts : undefined,
        year,
        month,
      )
    : null;
  const weeks = liveWeeks ?? buildSampleWeeks();
  const monthName = t(
    `scheduleScreen.month.${month}` as const,
    MONTH_NAMES[month] ?? "",
  );
  const monthLabel = haveLive ? `${monthName} ${year}` : "Mai 2026";

  const eventsForDay = (day: number | null): { t: string; k: EvKind }[] => {
    if (!day) return [];
    if (liveEvents) return liveEvents[day] ?? [];
    return SAMPLE_EVENTS[day] ?? [];
  };
  const isToday = (day: number | null): boolean =>
    day != null &&
    (haveLive ? viewingThisMonth && day === todayDate : day === 31);

  return (
    <div className="sr-content wide">
      <div className="sr-pagehead">
        <div className="sr-pagetitle">
          {t("scheduleScreen.pageTitle", "Tidsplan")}
        </div>
        <div className="sr-pagesub">
          {t(
            "scheduleScreen.pageSubtitle",
            "Faste opptak som gjentas automatisk — maskinen starter og stopper selv, også når ingen er til stede.",
          )}
        </div>
      </div>

      {/* "Vil maskinen ta opp?" — the volunteer's first scan. */}
      <ConfidencePanel
        nextIso={nextRecording}
        upcoming={upcoming}
        wakeEnabled={wakeEnabled}
        canWake={canWake}
        haveLive={haveLive}
        onEnableWake={() => enableWakeMutation.mutate()}
        enabling={enableWakeMutation.isPending}
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 312px",
          gap: 16,
          alignItems: "start",
        }}
      >
        {/* Calendar */}
        <div className="sr-card" style={{ padding: 18 }}>
          <div className="sr-row" style={{ marginBottom: 16 }}>
            <button
              className="sr-btn ghost sm"
              onClick={() => goMonth(-1)}
              disabled={!haveLive}
              title={t("scheduleScreen.prevMonth", "Forrige måned")}
            >
              <Icon
                name="chevR"
                size={14}
                style={{ transform: "rotate(180deg)" }}
              />
            </button>
            <button
              className="sr-btn ghost sm"
              onClick={goToday}
              disabled={!haveLive}
            >
              {t("scheduleScreen.today", "I dag")}
            </button>
            <div
              className="sr-grow"
              style={{ textAlign: "center", fontSize: 17, fontWeight: 650 }}
            >
              {monthLabel}
            </div>
            {/* Toggle church feast days ("Kirkehøytider") on/off. When on, the
                displayed month's liturgical days are merged in as blue pills. */}
            <button
              className={"sr-btn sm" + (showHolidays ? " gold" : " ghost")}
              style={
                showHolidays ? undefined : { color: "var(--sr-gold-bright)" }
              }
              aria-pressed={showHolidays}
              onClick={() => setShowHolidays((v) => !v)}
            >
              <Icon name="sparkle" size={14} />
              {t("scheduleScreen.churchFeasts", "Kirkehøytider")}
            </button>
            <button
              className="sr-btn ghost sm"
              onClick={() => goMonth(1)}
              disabled={!haveLive}
              title={t("scheduleScreen.nextMonth", "Neste måned")}
            >
              <Icon name="chevR" size={14} />
            </button>
          </div>
          <div
            style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)" }}
          >
            {dows.map((d) => (
              <div
                key={d}
                className="sr-label"
                style={{ padding: "0 8px 10px", textAlign: "right" }}
              >
                {d}
              </div>
            ))}
          </div>
          <div
            style={{
              borderTop: "1px solid var(--sr-line)",
              borderLeft: "1px solid var(--sr-line)",
              borderRadius: "var(--sr-r-xs)",
              overflow: "hidden",
            }}
          >
            {weeks.map((w, i) => (
              <div
                key={i}
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(7,1fr)",
                }}
              >
                {w.map((day, j) => (
                  <CalCell
                    key={j}
                    day={day}
                    events={eventsForDay(day)}
                    today={isToday(day)}
                    onClick={
                      haveLive && day != null
                        ? () => openSpecialEditor(isoDate(year, month, day))
                        : undefined
                    }
                  />
                ))}
              </div>
            ))}
          </div>
          <div className="sr-row" style={{ gap: 18, marginTop: 14 }}>
            {[
              [
                t("scheduleScreen.legendWeekly", "Ukentlig opptak"),
                "var(--sr-gold)",
              ],
              [
                t("scheduleScreen.legendSpecial", "Spesialopptak"),
                "var(--sr-red)",
              ],
              [
                t("scheduleScreen.legendFeast", "Kirkehøytid"),
                "var(--sr-blue)",
              ],
            ].map(([label, c]) => (
              <span
                key={label}
                className="sr-row"
                style={{ gap: 7, fontSize: 12.5, color: "var(--sr-text-3)" }}
              >
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: c,
                  }}
                />
                {label}
              </span>
            ))}
          </div>
        </div>

        {/* Right rail */}
        <div className="sr-stack-3">
          <div
            className="sr-card pad"
            onClick={haveLive ? () => openSpecialEditor() : undefined}
            style={{
              padding: 16,
              borderColor: "var(--sr-gold-line)",
              background: "var(--sr-gold-tint)",
              cursor: haveLive ? "pointer" : "default",
            }}
          >
            <div className="sr-row" style={{ gap: 9 }}>
              <Icon
                name="plus"
                size={16}
                style={{ color: "var(--sr-gold-bright)" }}
              />
              <span
                style={{
                  fontSize: 13.5,
                  fontWeight: 600,
                  color: "var(--sr-gold-bright)",
                }}
              >
                {t(
                  "scheduleScreen.clickDayHint",
                  "Klikk på en dag for å legge til opptak",
                )}
              </span>
            </div>
          </div>
          <Card
            title={t(
              "scheduleScreen.plannedSpecials",
              "Planlagte spesialopptak",
            )}
            pad
          >
            {specials.length === 0 ? (
              <div
                style={{
                  textAlign: "center",
                  padding: "20px 0",
                  color: "var(--sr-text-dim)",
                  fontSize: 13,
                }}
              >
                <Icon name="calendar" size={26} style={{ opacity: 0.4 }} />
                <div style={{ marginTop: 8 }}>
                  {t(
                    "scheduleScreen.noUpcomingSpecials",
                    "Ingen kommende spesialopptak",
                  )}
                </div>
              </div>
            ) : (
              <div
                style={{ display: "flex", flexDirection: "column", gap: 10 }}
              >
                {specials.map((sp, i) => (
                  <div
                    key={sp.id ?? i}
                    className="sr-row"
                    style={{
                      padding: 12,
                      borderRadius: "var(--sr-r-sm)",
                      background: "var(--sr-ink-750)",
                      borderLeft: "3px solid var(--sr-red)",
                    }}
                  >
                    <div className="sr-grow">
                      <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                        {sp.name ||
                          t("scheduleScreen.specialFallback", "Spesialopptak")}
                      </div>
                      <div
                        style={{
                          fontSize: 12.5,
                          color: "var(--sr-text-3)",
                          marginTop: 2,
                        }}
                      >
                        {formatSpecialDate(sp.date)} · {sp.start} – {sp.stop}
                      </div>
                    </div>
                    <button
                      className="sr-btn ghost sm"
                      style={{ padding: 7, flex: "0 0 auto" }}
                      onClick={() => removeSpecial(i)}
                      disabled={!haveLive}
                      title={t(
                        "scheduleScreen.removeSpecial",
                        "Fjern spesialopptak",
                      )}
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* Weekly schedule */}
      <div className="sr-card pad" style={{ marginTop: 16 }}>
        <div className="sr-card-title" style={{ marginBottom: 6 }}>
          <Icon name="clock" size={17} />
          {t("scheduleScreen.weeklyTitle", "Ukentlig tidsplan")}
        </div>
        <div className="sr-card-desc" style={{ marginBottom: 16 }}>
          {t(
            "scheduleScreen.weeklyDesc",
            "Faste opptak som gjentas hver uke — for eksempel gudstjeneste hver søndag.",
          )}
        </div>
        {slots.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "24px 0",
              color: "var(--sr-text-dim)",
              fontSize: 13,
            }}
          >
            <Icon name="clock" size={26} style={{ opacity: 0.4 }} />
            <div style={{ marginTop: 8 }}>
              {t(
                "scheduleScreen.noWeeklySlots",
                "Ingen ukentlige opptak ennå. Legg til et tidspunkt under.",
              )}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {slots.map((slot, i) => {
              const next = nextOccurrence(slot, upcoming);
              const editing = editingSlot === i;
              return (
                <div
                  key={i}
                  style={{
                    borderRadius: "var(--sr-r-sm)",
                    background: "var(--sr-ink-750)",
                    borderLeft: "3px solid var(--sr-gold)",
                  }}
                >
                  <div className="sr-row" style={{ padding: 14 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, width: 48 }}>
                      {slotDayLabel(slot, dows)}
                    </div>
                    <div className="sr-grow">
                      <div style={{ fontSize: 14, fontWeight: 600 }}>
                        {slotTimeRange(slot)}
                      </div>
                      {next && (
                        <div
                          style={{ fontSize: 12.5, color: "var(--sr-gold)" }}
                        >
                          {t(
                            "scheduleScreen.nextAt",
                            "Neste opptak: {{when}}",
                            {
                              when: next,
                            },
                          )}
                        </div>
                      )}
                    </div>
                    <button
                      className="sr-btn ghost sm"
                      onClick={() => setEditingSlot(editing ? null : i)}
                      disabled={!haveLive}
                    >
                      {editing
                        ? t("scheduleScreen.done", "Ferdig")
                        : t("scheduleScreen.edit", "Rediger")}
                    </button>
                    <button
                      className="sr-btn ghost sm"
                      style={{ padding: 7 }}
                      onClick={() => removeSlot(i)}
                      disabled={!haveLive}
                      title={t("scheduleScreen.removeSlot", "Fjern tidspunkt")}
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                  {editing && (
                    <div
                      style={{
                        padding: "0 14px 14px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 12,
                      }}
                    >
                      {/* Weekday picker — backend order, 0 = Man … 6 = Søn. */}
                      <div
                        className="sr-row"
                        style={{ gap: 6, flexWrap: "wrap" }}
                      >
                        {dows.map((label, day) => {
                          const on = slot.days.includes(day);
                          return (
                            <button
                              key={day}
                              className={
                                "sr-btn sm" + (on ? " gold" : " ghost")
                              }
                              style={{ minWidth: 46, justifyContent: "center" }}
                              aria-pressed={on}
                              onClick={() => toggleSlotDay(i, day)}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                      <div
                        className="sr-row"
                        style={{ gap: 10, flexWrap: "wrap" }}
                      >
                        <input
                          type="time"
                          className="sr-input"
                          style={{ width: 120 }}
                          aria-label={t("scheduleScreen.start", "Start")}
                          value={slot.start}
                          onChange={(e) =>
                            updateSlot(i, { start: e.target.value })
                          }
                        />
                        <span style={{ color: "var(--sr-text-3)" }}>–</span>
                        <input
                          type="time"
                          className="sr-input"
                          style={{ width: 120 }}
                          aria-label={t("scheduleScreen.stop", "Stopp")}
                          value={slot.stop}
                          onChange={(e) =>
                            updateSlot(i, { stop: e.target.value })
                          }
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <button
          className="sr-btn ghost"
          style={{ marginTop: 12 }}
          onClick={addSlot}
          disabled={!haveLive}
        >
          <Icon name="plus" size={15} />
          {t("scheduleScreen.addSlot", "Legg til tidspunkt")}
        </button>
      </div>

      {/* Wake from sleep */}
      <div className="sr-card pad" style={{ marginTop: 12 }}>
        <div className="sr-row">
          <Icon name="power" size={18} style={{ color: "var(--sr-text-3)" }} />
          <div className="sr-grow">
            <div style={{ fontSize: 14.5, fontWeight: 600 }}>
              {t("scheduleScreen.wakeTitle", "Vekk maskin fra dvale")}
            </div>
            <div className="sr-srow-d">
              {t(
                "scheduleScreen.wakeDesc",
                "Lar maskinen våkne i tide til opptak og verifiserer at det fungerer.",
              )}
            </div>
          </div>
          <Badge kind={wakeActive ? "ok" : "muted"} dot>
            {wakeActive
              ? t("scheduleScreen.active", "Aktiv")
              : t("scheduleScreen.inactive", "Inaktiv")}
          </Badge>
          <Icon name="chevD" size={18} style={{ color: "var(--sr-text-3)" }} />
        </div>
      </div>

      {/* Add-special editor — a minimal modal built from sr-card so it matches
          the design. Persists on save, no-ops gracefully without live data. */}
      {draftSpecial && (
        <div
          onClick={() => setDraftSpecial(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
            padding: 24,
          }}
        >
          <div
            className="sr-card pad"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 420, maxWidth: "100%" }}
          >
            <div className="sr-card-title" style={{ marginBottom: 14 }}>
              <Icon name="calendar" size={17} />
              {t("scheduleScreen.newSpecial", "Nytt spesialopptak")}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="sr-field">
                <label className="sr-label">
                  {t("scheduleScreen.fieldName", "Navn")}
                </label>
                <input
                  className="sr-input"
                  type="text"
                  placeholder={t(
                    "scheduleScreen.namePlaceholder",
                    "F.eks. Julegudstjeneste",
                  )}
                  value={draftSpecial.name}
                  onChange={(e) =>
                    setDraftSpecial({ ...draftSpecial, name: e.target.value })
                  }
                />
              </div>
              <div className="sr-field">
                <label className="sr-label">
                  {t("scheduleScreen.fieldDate", "Dato")}
                </label>
                <input
                  className="sr-input"
                  type="date"
                  value={draftSpecial.date}
                  onChange={(e) =>
                    setDraftSpecial({ ...draftSpecial, date: e.target.value })
                  }
                />
              </div>
              <div className="sr-row" style={{ gap: 10 }}>
                <div className="sr-field sr-grow">
                  <label className="sr-label">
                    {t("scheduleScreen.start", "Start")}
                  </label>
                  <input
                    className="sr-input"
                    type="time"
                    value={draftSpecial.start}
                    onChange={(e) =>
                      setDraftSpecial({
                        ...draftSpecial,
                        start: e.target.value,
                      })
                    }
                  />
                </div>
                <div className="sr-field sr-grow">
                  <label className="sr-label">
                    {t("scheduleScreen.stop", "Stopp")}
                  </label>
                  <input
                    className="sr-input"
                    type="time"
                    value={draftSpecial.stop}
                    onChange={(e) =>
                      setDraftSpecial({
                        ...draftSpecial,
                        stop: e.target.value,
                      })
                    }
                  />
                </div>
              </div>
            </div>
            <div
              className="sr-row"
              style={{ marginTop: 18, justifyContent: "flex-end", gap: 10 }}
            >
              <button
                className="sr-btn ghost"
                onClick={() => setDraftSpecial(null)}
              >
                {t("scheduleScreen.cancel", "Avbryt")}
              </button>
              <button
                className="sr-btn gold"
                onClick={saveDraftSpecial}
                disabled={!haveLive || !draftSpecial.date}
              >
                <Icon name="plus" size={15} />
                {t("scheduleScreen.add", "Legg til")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
