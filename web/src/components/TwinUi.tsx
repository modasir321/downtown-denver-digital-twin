"use client";

import type { ReactNode } from "react";

/** Shared type scale — audit: ≥12px labels, readable body */
export const twinType = {
  label: "text-xs font-semibold uppercase tracking-[0.14em] text-slate-300",
  body: "text-sm leading-relaxed text-slate-300",
  hint: "text-xs leading-relaxed text-slate-400",
  metricLabel: "text-xs font-medium uppercase tracking-wider text-slate-400",
} as const;

/** Showcase glass panel — slate glassmorphism */
export function TwinGlassPanel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-slate-800/80 bg-slate-950/85 p-4 shadow-2xl backdrop-blur-xl ${className}`}
    >
      {children}
    </div>
  );
}

/** Section divider inside a glass panel (grouping) */
export function TwinDivider({ className = "" }: { className?: string }) {
  return <div className={`my-3 border-t border-slate-700/80 ${className}`} />;
}

/**
 * Hierarchy: high-contrast brand badge (audit suggestion).
 */
export function TwinBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-cyan-400/50 bg-cyan-500/20 px-3 py-1 text-xs font-bold uppercase tracking-[0.16em] text-cyan-200 shadow-[0_0_12px_rgba(34,211,238,0.25)]">
      {children}
    </span>
  );
}

export function TwinMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-slate-800/80 bg-slate-900/50 px-3 py-2.5">
      <div className={twinType.metricLabel}>{label}</div>
      <div className="mt-0.5 text-lg font-semibold tracking-tight text-white">{value}</div>
    </div>
  );
}

const HEIGHT_LEGEND = [
  { color: "#86efac", range: "<12 m", label: "Low" },
  { color: "#38bdf8", range: "12–25 m", label: "Mid" },
  { color: "#a78bfa", range: "25–50 m", label: "Tall" },
  { color: "#fb923c", range: "50–100 m", label: "High-rise" },
  { color: "#ef4444", range: "100+ m", label: "Tower" },
] as const;

/** Density: more line-height + ≥12px legend rows */
export function TwinHeightLegend() {
  return (
    <div>
      <p className={`mb-2.5 ${twinType.label}`}>Height</p>
      <div className="flex flex-col gap-2.5">
        {HEIGHT_LEGEND.map((row) => (
          <div key={row.range} className="flex items-center gap-2.5 text-sm text-slate-200">
            <span
              className="h-3 w-3 shrink-0 rounded-full shadow-[0_0_8px_rgba(255,255,255,0.25)] ring-1 ring-white/20"
              style={{ backgroundColor: row.color }}
            />
            <span className="w-[4.5rem] tabular-nums text-slate-400">{row.range}</span>
            <span className="font-medium">{row.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

type Accent = "emerald" | "sky" | "amber" | "orange" | "cyan";

const ACTIVE_ACCENT: Record<Accent, string> = {
  emerald:
    "border-emerald-500/50 bg-emerald-500/15 text-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.2)]",
  sky: "border-sky-500/50 bg-sky-500/15 text-sky-300 shadow-[0_0_12px_rgba(14,165,233,0.2)]",
  amber:
    "border-amber-500/50 bg-amber-500/15 text-amber-200 shadow-[0_0_12px_rgba(245,158,11,0.2)]",
  orange:
    "border-orange-500/50 bg-orange-500/15 text-orange-300 shadow-[0_0_12px_rgba(249,115,22,0.2)]",
  cyan: "border-cyan-500/50 bg-cyan-500/15 text-cyan-300 shadow-[0_0_12px_rgba(34,211,238,0.22)]",
};

/** Shared geometry for all control buttons (consistency: ≤3 variants) */
const BTN_BASE =
  "inline-flex items-center justify-center rounded-lg border px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40";

/**
 * Toggle / selection chip — primary interactive control.
 * Active = accent fill; inactive = secondary glass.
 */
export function TwinToggleChip({
  active,
  onClick,
  children,
  accent = "emerald",
  className = "",
  disabled = false,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  accent?: Accent;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${BTN_BASE} ${
        active
          ? ACTIVE_ACCENT[accent]
          : "border-slate-700/80 bg-slate-900/60 text-slate-300 hover:bg-slate-800/70"
      } ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * Secondary action — subtle fill (not bare ghost) for affordance on dark maps.
 */
export function TwinButton({
  onClick,
  children,
  className = "",
  disabled = false,
  variant = "secondary",
}: {
  onClick: () => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  variant?: "primary" | "secondary";
}) {
  const variantCls =
    variant === "primary"
      ? "border-cyan-500/45 bg-cyan-500/20 text-cyan-200 hover:bg-cyan-500/30 shadow-[0_0_12px_rgba(34,211,238,0.15)]"
      : "border-slate-600/80 bg-slate-800/70 text-slate-200 hover:bg-slate-700/80";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${BTN_BASE} ${variantCls} ${className}`}
    >
      {children}
    </button>
  );
}

export function formatCount(n: number | undefined | null): string {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US");
}

export type InspectTipData = {
  x: number;
  y: number;
  heightM: number;
  floors: number;
  neighborhood: string;
  visible?: boolean;
};

/** Polished building inspection card — fades in/out, hierarchical type + icons */
export function TwinInspectTooltip({ tip }: { tip: InspectTipData | null }) {
  const show = Boolean(tip?.visible !== false && tip);

  return (
    <div
      className={`pointer-events-none absolute z-30 min-w-[190px] -translate-y-full rounded-xl border border-slate-700/80 bg-slate-950/95 px-3.5 py-2.5 shadow-2xl backdrop-blur-xl transition-opacity duration-150 ${
        show ? "opacity-100" : "opacity-0"
      }`}
      style={
        tip
          ? { left: tip.x + 16, top: tip.y - 12 }
          : { left: -9999, top: 0 }
      }
      aria-hidden={!show}
    >
      {tip && (
        <>
          <p className="text-sm font-bold tracking-tight text-white">{tip.neighborhood}</p>
          <div className="mt-2 space-y-2">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-cyan-500/15 text-xs text-cyan-300">
                ▮
              </span>
              <div>
                <p className="text-xs uppercase tracking-wider text-slate-500">Height</p>
                <p className="text-sm font-semibold tabular-nums text-slate-100">
                  {tip.heightM.toFixed(1)} m
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-violet-500/15 text-xs text-violet-300">
                ≡
              </span>
              <div>
                <p className="text-xs uppercase tracking-wider text-slate-500">Est. floors</p>
                <p className="text-sm font-semibold tabular-nums text-slate-100">~{tip.floors}</p>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
