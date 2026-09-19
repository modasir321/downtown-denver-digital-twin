"use client";

import dynamic from "next/dynamic";

const TwinWorkspace = dynamic(() => import("@/components/TwinWorkspace"), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen w-screen items-center justify-center bg-[#0b1220] text-slate-300">
      Loading Downtown Denver…
    </div>
  ),
});

export default function Home() {
  return <TwinWorkspace />;
}
