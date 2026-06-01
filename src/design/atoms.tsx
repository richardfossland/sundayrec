/**
 * SundayRec redesign — shared atoms.
 *
 * Ported from the Claude Design handoff (`sr-shell.jsx` + screen files). These
 * are thin presentational wrappers over the `sr-*` classes defined in
 * `tokens.css`; they carry no IPC. Functionality (real toggles, device data,
 * live meters) is wired in a later pass — for now props are plain values so the
 * redesign matches the mockup pixel-for-pixel.
 */
import type { CSSProperties, ReactNode } from "react";

import { Icon, type IconName } from "./Icon";

/* ── Toggle switch ──────────────────────────────────────────────────────── */
export function Toggle({ on = false }: { on?: boolean }) {
  return <div className={"sr-toggle" + (on ? " on" : "")} />;
}

/* ── Badge / chip ───────────────────────────────────────────────────────── */
export type BadgeKind = "muted" | "ok" | "warn" | "err" | "gold";
export function Badge({
  kind = "muted",
  children,
  dot,
}: {
  kind?: BadgeKind;
  children: ReactNode;
  dot?: boolean;
}) {
  return (
    <span className={"sr-badge " + kind}>
      {dot && <span className="bdot" />}
      {children}
    </span>
  );
}

/* ── Button ─────────────────────────────────────────────────────────────── */
export type BtnVariant = "ghost" | "gold" | "danger";
export function Btn({
  variant,
  sm,
  block,
  icon,
  iconFill,
  children,
  style,
  onClick,
  type = "button",
}: {
  variant?: BtnVariant;
  sm?: boolean;
  block?: boolean;
  icon?: IconName;
  iconFill?: boolean;
  children?: ReactNode;
  style?: CSSProperties;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  const cls = ["sr-btn", variant, sm && "sm", block && "block"]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={cls} style={style} onClick={onClick} type={type}>
      {icon && <Icon name={icon} size={sm ? 14 : 16} fill={iconFill} />}
      {children}
    </button>
  );
}

/* ── Segmented option card ──────────────────────────────────────────────── */
export function SegOpt({
  sel,
  title,
  sub,
  badge,
}: {
  sel?: boolean;
  title: ReactNode;
  sub?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <div className={"sr-seg-opt" + (sel ? " sel" : "")}>
      <div className="t">{title}</div>
      {badge && (
        <div style={{ margin: "6px 0" }}>
          <Badge kind="warn">{badge}</Badge>
        </div>
      )}
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

/* ── Audio meter (n of total segments lit) ──────────────────────────────── */
export function Meter({ on = 4, total = 14 }: { on?: number; total?: number }) {
  return (
    <div className="sr-meter">
      {Array.from({ length: total }).map((_, i) => {
        const cls =
          i < on ? (i > total - 3 ? "hot" : i > total - 6 ? "mid" : "on") : "";
        return <span key={i} className={"seg " + cls} />;
      })}
    </div>
  );
}

/* ── Setting row (label/desc left, control right) ───────────────────────── */
export function SettingRow({
  title,
  desc,
  control,
}: {
  title: ReactNode;
  desc?: ReactNode;
  control: ReactNode;
}) {
  return (
    <div className="sr-srow">
      <div className="sr-grow">
        <div className="sr-srow-t">{title}</div>
        {desc && <div className="sr-srow-d">{desc}</div>}
      </div>
      <div style={{ flex: "0 0 auto" }}>{control}</div>
    </div>
  );
}

/* ── Card ───────────────────────────────────────────────────────────────── */
export function Card({
  title,
  icon,
  desc,
  action,
  children,
  pad = true,
  cls = "",
  style,
}: {
  title?: ReactNode;
  icon?: IconName;
  desc?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  pad?: boolean;
  cls?: string;
  style?: CSSProperties;
}) {
  return (
    <section className={"sr-card " + (pad ? "pad " : "") + cls} style={style}>
      {(title || action) && (
        <div className="sr-card-head">
          <div>
            <div className="sr-card-title">
              {icon && <Icon name={icon} size={17} />}
              {title}
            </div>
            {desc && (
              <div className="sr-card-desc" style={{ marginTop: 6 }}>
                {desc}
              </div>
            )}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/* ── Device / summary card (Home rail, settings device list) ────────────── */
export function DeviceCard({
  icon,
  k,
  v,
  meta,
  badge,
  progress,
  onEdit,
}: {
  icon: IconName;
  k: ReactNode;
  v: ReactNode;
  meta?: ReactNode;
  badge?: ReactNode;
  progress?: number;
  /** When provided, renders the "Endre" button and calls this on click.
   *  Omit it for a purely informational card (no dead button). */
  onEdit?: () => void;
}) {
  return (
    <div className="sr-device">
      <div className="sr-device-ico">
        <Icon name={icon} size={19} />
      </div>
      <div className="sr-device-body">
        <div className="sr-device-k">{k}</div>
        <div className="sr-device-v">{v}</div>
        {meta && <div className="sr-device-meta">{meta}</div>}
        {badge && <div style={{ marginTop: 6 }}>{badge}</div>}
        {progress != null && (
          <div
            style={{
              marginTop: 9,
              height: 5,
              borderRadius: 3,
              background: "var(--sr-ink-700)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: progress + "%",
                height: "100%",
                background: "var(--sr-green)",
              }}
            />
          </div>
        )}
      </div>
      {onEdit && (
        <button
          className="sr-btn ghost sm"
          style={{ flex: "0 0 auto" }}
          onClick={onEdit}
          type="button"
        >
          Endre
        </button>
      )}
    </div>
  );
}

/* ── Settings-list device row (selectable) ──────────────────────────────── */
export function DeviceRow({
  icon,
  name,
  meta,
  sel,
  badge,
}: {
  icon: IconName;
  name: ReactNode;
  meta?: ReactNode;
  sel?: boolean;
  badge?: ReactNode;
}) {
  return (
    <div className={"sr-device" + (sel ? " sel" : "")}>
      <div className="sr-device-ico">
        <Icon name={icon} size={19} />
      </div>
      <div className="sr-device-body">
        <div className="sr-row" style={{ gap: 9 }}>
          <span className="sr-device-v" style={{ marginTop: 0 }}>
            {name}
          </span>
          {badge}
        </div>
        <div className="sr-device-meta">{meta}</div>
      </div>
      {sel && (
        <Icon
          name="check"
          size={18}
          strokeWidth={2.4}
          style={{ color: "var(--sr-gold)", flex: "0 0 auto" }}
        />
      )}
    </div>
  );
}

/* ── Ready chip (Home "Klar til opptak" pills) ──────────────────────────── */
export function ReadyChip({ ok, label }: { ok?: boolean; label: ReactNode }) {
  return (
    <div
      className="sr-row"
      style={{
        gap: 7,
        padding: "5px 10px",
        borderRadius: "var(--sr-r-pill)",
        background: "var(--sr-line-faint)",
        border: "1px solid var(--sr-line)",
      }}
    >
      <span
        style={{
          color: ok ? "var(--sr-green)" : "var(--sr-gold)",
          display: "flex",
        }}
      >
        <Icon name={ok ? "check" : "warn"} size={14} strokeWidth={2.2} />
      </span>
      <span
        style={{ fontSize: 12.5, fontWeight: 600, color: "var(--sr-text-2)" }}
      >
        {label}
      </span>
    </div>
  );
}

/* ── Collapsible card (editor sections) ─────────────────────────────────── */
export function Collapsible({
  icon,
  title,
  meta,
  open,
  children,
}: {
  icon: IconName;
  title: ReactNode;
  meta?: ReactNode;
  open?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="sr-card pad">
      <div className="sr-row">
        <Icon name={icon} size={17} style={{ color: "var(--sr-text-3)" }} />
        <span className="sr-grow" style={{ fontSize: 15, fontWeight: 600 }}>
          {title}
        </span>
        {meta}
        <Icon
          name={open ? "chevD" : "chevR"}
          size={17}
          style={{ color: "var(--sr-text-3)" }}
        />
      </div>
      {open && children && <div style={{ marginTop: 16 }}>{children}</div>}
    </div>
  );
}
