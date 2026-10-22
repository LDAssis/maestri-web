"use client";

import React from "react";
import { ARRANGE_COLORS, COLOR_HEX, ICON_MAP } from "./palette";

// Cor e ícone de um preset de CLI (campos `color`/`icon` das configurações; o servidor os usa nos presets)
export default function PresetLookFields({ color, icon, onChange }: { color?: string; icon?: string; onChange: (patch: { color?: string; icon?: string }) => void }) {
  const sel = "bg-slate-950 border border-slate-800 rounded px-1 py-1 text-[11px] text-slate-300";
  return (
    <>
      <span className="h-3 w-3 rounded-full shrink-0 border border-slate-700" style={{ background: color ? COLOR_HEX[color] ?? "#64748b" : "transparent" }} aria-hidden />
      <select aria-label="Cor do preset" value={color && (ARRANGE_COLORS as readonly string[]).includes(color) ? color : ""} onChange={(e) => onChange({ color: e.target.value || undefined })} className={sel}>
        <option value="">cor</option>
        {ARRANGE_COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <select aria-label="Ícone do preset" value={icon && icon in ICON_MAP ? icon : ""} onChange={(e) => onChange({ icon: e.target.value || undefined })} className={sel}>
        <option value="">ícone</option>
        {Object.keys(ICON_MAP).map((i) => <option key={i} value={i}>{i}</option>)}
      </select>
    </>
  );
}
