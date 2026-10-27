"use client";

import { useState } from "react";
import type { ChanceOfProfit } from "@/lib/engine/replay-stats";

/**
 * Chance-of-profit fan: outer band = 5th–95th percentile, inner band = 25th–75th,
 * line = median, dashed = break-even. One hue (accent) at stepped opacity.
 */
export default function FanChart({ fan, title }: { fan: ChanceOfProfit; title: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = 200, PL = 44, PR = 8, PT = 10, PB = 22;
  const steps = fan.steps;
  const lo = Math.min(0, ...steps.map((s) => s.p5));
  const hi = Math.max(0, ...steps.map((s) => s.p95));
  const x = (i: number) => PL + (i / fan.horizon) * (W - PL - PR);
  const y = (v: number) => PT + (1 - (v - lo) / Math.max(1e-9, hi - lo)) * (H - PT - PB);
  const band = (a: "p5" | "p25", b: "p95" | "p75") =>
    `M${steps.map((s) => `${x(s.i).toFixed(1)},${y(s[b]).toFixed(1)}`).join(" L")} L${[...steps].reverse().map((s) => `${x(s.i).toFixed(1)},${y(s[a]).toFixed(1)}`).join(" L")} Z`;
  const median = `M${steps.map((s) => `${x(s.i).toFixed(1)},${y(s.p50).toFixed(1)}`).join(" L")}`;
  const h = hover != null ? steps[hover] : null;
  const ticks = [lo, 0, hi].filter((v, i, a) => a.indexOf(v) === i);

  return (
    <figure className="replay-curve fan">
      <figcaption>{title}</figcaption>
      <div className="fan-head">
        <div><span>Chance of profit after {fan.horizon} trades</span><strong className={fan.pProfitPct >= 50 ? "exec-pos" : "exec-neg"}>{fan.pProfitPct}%</strong></div>
        <div><span>Median outcome</span><strong>{fan.medianFinalPct > 0 ? "+" : ""}{fan.medianFinalPct}%</strong></div>
        <div><span>Bad case (5th pct)</span><strong>{fan.p5FinalPct > 0 ? "+" : ""}{fan.p5FinalPct}%</strong></div>
        <div><span>Good case (95th pct)</span><strong>{fan.p95FinalPct > 0 ? "+" : ""}{fan.p95FinalPct}%</strong></div>
      </div>
      <div className="fan-plot">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${title}: ${fan.pProfitPct}% chance of profit`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const rel = ((e.clientX - r.left) / r.width) * W;
          const i = ((rel - PL) / (W - PL - PR)) * fan.horizon;
          let best = 0;
          steps.forEach((s, k) => { if (Math.abs(s.i - i) < Math.abs(steps[best].i - i)) best = k; });
          setHover(best);
        }}>
        {ticks.map((t) => <line key={t} x1={PL} x2={W - PR} y1={y(t)} y2={y(t)} className={t === 0 ? "replay-base" : "fan-grid"} />)}
        <path d={band("p5", "p95")} className="fan-outer" />
        <path d={band("p25", "p75")} className="fan-inner" />
        <path d={median} className="replay-line" />
        {h && hover != null && <>
          <line x1={x(h.i)} x2={x(h.i)} y1={PT} y2={H - PB} className="replay-cross" />
          <circle cx={x(h.i)} cy={y(h.p50)} r={4} className="replay-dot" />
        </>}
      </svg>
      {/* Axis labels live in HTML so the stretched SVG never distorts the text. */}
      {ticks.map((t) => <span key={t} className="fan-axis" style={{ top: `${(y(t) / H) * 100}%`, left: 0 }}>{t > 0 ? "+" : ""}{Math.round(t)}%</span>)}
      <span className="fan-axis" style={{ bottom: 0, left: `${(PL / W) * 100}%` }}>0</span>
      <span className="fan-axis" style={{ bottom: 0, right: 0 }}>{fan.horizon} trades</span>
      </div>
      <div className="replay-tip" aria-live="polite">
        {h ? `After ${h.i} trades · median ${h.p50}% · middle half ${h.p25}% to ${h.p75}% · 90% range ${h.p5}% to ${h.p95}%`
          : `Bootstrapped from ${fan.sample} trades × ${fan.paths.toLocaleString()} paths, each trade risking one of 3 slots. Not a forecast: it only replays the past mix of wins and losses.`}
      </div>
    </figure>
  );
}
