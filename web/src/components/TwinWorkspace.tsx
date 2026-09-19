"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";

const DigitalTwinMap = dynamic(() => import("@/components/DigitalTwinMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[100dvh] w-screen items-center justify-center bg-[#0b1220] text-slate-300">
      Loading Mapbox view…
    </div>
  ),
});

const CesiumTwinGlobe = dynamic(() => import("@/components/CesiumTwinGlobe"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[100dvh] w-screen items-center justify-center bg-[#0b1220] text-slate-300">
      Loading Cesium globe…
    </div>
  ),
});

type ViewMode = "map" | "globe";

const STORAGE_KEY = "twin-view-mode";

export default function TwinWorkspace() {
  const [view, setView] = useState<ViewMode>("map");
  const [hydrated, setHydrated] = useState(false);
  /** Mount Cesium only when user opens 3D — never warm-load it on Map. */
  const [globeMounted, setGlobeMounted] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "map" || saved === "globe") setView(saved);
      if (saved === "globe") setGlobeMounted(true);
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, view);
    } catch {
      /* ignore */
    }
  }, [view, hydrated]);

  const showMap = view === "map";
  const showGlobe = view === "globe";

  return (
    <div className="relative h-[100dvh] w-screen overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          visibility: showMap ? "visible" : "hidden",
          pointerEvents: showMap ? "auto" : "none",
          zIndex: showMap ? 1 : 0,
        }}
        aria-hidden={!showMap}
      >
        <DigitalTwinMap active={showMap} />
      </div>

      {globeMounted && (
        <div
          className="absolute inset-0"
          style={{
            visibility: showGlobe ? "visible" : "hidden",
            pointerEvents: showGlobe ? "auto" : "none",
            zIndex: showGlobe ? 1 : 0,
          }}
          aria-hidden={!showGlobe}
        >
          <CesiumTwinGlobe active={showGlobe} />
        </div>
      )}

      <div className="pointer-events-auto absolute left-1/2 top-4 z-40 flex -translate-x-1/2 overflow-hidden rounded-2xl border border-slate-800/80 bg-slate-950/85 p-1 shadow-2xl backdrop-blur-xl">
        <button
          type="button"
          onClick={() => setView("map")}
          className={`rounded-xl px-4 py-2 text-[12px] font-semibold tracking-wide transition ${
            showMap
              ? "border border-amber-500/50 bg-amber-500/15 text-amber-200 shadow-[0_0_15px_rgba(245,158,11,0.2)]"
              : "border border-transparent text-slate-400 hover:bg-slate-800/50"
          }`}
        >
          Map
        </button>
        <button
          type="button"
          onClick={() => {
            setGlobeMounted(true);
            setView("globe");
          }}
          className={`rounded-xl px-4 py-2 text-[12px] font-semibold tracking-wide transition ${
            showGlobe
              ? "border border-emerald-500/50 bg-emerald-500/15 text-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.2)]"
              : "border border-transparent text-slate-400 hover:bg-slate-800/50"
          }`}
        >
          3D Globe
        </button>
      </div>
    </div>
  );
}
