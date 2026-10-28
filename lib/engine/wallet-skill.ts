// Polymarket wallet skill analysis (V6.0). Pure, deterministic (seeded).
//
// A prediction-market price IS a probability. So the honest luck test is: if this trader had
// no information, each position would have won with the probability they paid for it. We
// simulate thousands of such "no-skill" histories and ask how often luck alone matches the
// real P&L. Then we correct for scanning many wallets at once (Benjamini–Hochberg), and
// demand the edge also shows up in a later window the first test never saw.

export type Fill = { conditionId: string; outcomeIndex: number; side: "BUY" | "SELL"; price: number; size: number; usdc: number; timestamp: number; title?: string };
export type Resolution = { conditionId: string; winningIndex: number | null; endTs?: number | null; title?: string };
export type MarketPosition = { conditionId: string; outcomeIndex: number; title: string; cost: number; proceeds: number; tokens: number; avgPrice: number; payoff: 0 | 1; pnl: number; firstTs: number; hoursBeforeEnd: number | null };

export type WalletSkill = {
  wallet: string; name?: string | null;
  markets: number; wins: number; winRatePct: number; cost: number; pnl: number; roiPct: number;
  avgEntryPrice: number; impliedWinRatePct: number; brierEdge: number;
  pLuck: number; qValue?: number; earlyP: number | null; lateP: number | null; lateMarkets: number; lateRoiPct: number | null;
  largestShareOfPnlPct: number; medianBetUsd: number; sizeSkillCorr: number | null;
  medianHoursBeforeEnd: number | null; lastDayEntriesPct: number;
  style: string; verdict: "SKILL — HELD OUT" | "SKILL? NOT CONFIRMED" | "LUCK / NOT SIGNIFICANT" | "TOO FEW MARKETS" | "EXCLUDED";
  reasons: string[];
};

/** Net each (market, outcome) into a resolved position. Unresolved markets are skipped. */
export function positionsFrom(fills: Fill[], res: Map<string, Resolution>): MarketPosition[] {
  const by = new Map<string, MarketPosition & { _n: number }>();
  for (const f of fills) {
    const r = res.get(f.conditionId);
    if (!r || r.winningIndex == null) continue;
    const key = `${f.conditionId}:${f.outcomeIndex}`;
    const p = by.get(key) ?? { conditionId: f.conditionId, outcomeIndex: f.outcomeIndex, title: f.title ?? r.title ?? f.conditionId, cost: 0, proceeds: 0, tokens: 0, avgPrice: 0, payoff: (r.winningIndex === f.outcomeIndex ? 1 : 0) as 0 | 1, pnl: 0, firstTs: f.timestamp, hoursBeforeEnd: null, _n: 0 };
    if (f.side === "BUY") { p.cost += f.usdc; p.tokens += f.size; } else { p.proceeds += f.usdc; p.tokens -= f.size; }
    p.firstTs = Math.min(p.firstTs, f.timestamp);
    p._n += 1;
    by.set(key, p);
  }
  const out: MarketPosition[] = [];
  for (const p of by.values()) {
    if (p.cost <= 0) continue; // sells without buys in-window (inventory from before) can't be scored
    const bought = fillsTokens(fills, p.conditionId, p.outcomeIndex);
    p.avgPrice = bought > 0 ? p.cost / bought : 0;
    p.pnl = p.proceeds + Math.max(0, p.tokens) * p.payoff - p.cost;
    const end = res.get(p.conditionId)?.endTs;
    p.hoursBeforeEnd = end ? Math.max(0, (end - p.firstTs) / 3600) : null;
    const { _n, ...rest } = p; void _n;
    out.push(rest);
  }
  return out;
}

function fillsTokens(fills: Fill[], c: string, i: number) {
  return fills.filter((f) => f.conditionId === c && f.outcomeIndex === i && f.side === "BUY").reduce((a, f) => a + f.size, 0);
}

function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * P(no-skill trader matches this P&L). Each position's outcome is redrawn as
 * Bernoulli(average entry price); proceeds from sells are kept as they happened.
 */
export function luckPValue(pos: MarketPosition[], sims = 4000, seed = 7) {
  if (!pos.length) return 1;
  const actual = pos.reduce((a, p) => a + p.pnl, 0);
  const rand = mulberry32(seed);
  let hits = 0;
  for (let s = 0; s < sims; s += 1) {
    let pnl = 0;
    for (const p of pos) {
      const win = rand() < Math.min(0.999, Math.max(0.001, p.avgPrice)) ? 1 : 0;
      pnl += p.proceeds + Math.max(0, p.tokens) * win - p.cost;
    }
    if (pnl >= actual - 1e-9) hits += 1;
  }
  return (hits + 1) / (sims + 1);
}

/** Benjamini–Hochberg q-values (false discovery rate) for many wallets tested at once. */
export function bhQValues(ps: number[]) {
  const n = ps.length;
  const idx = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  const q = new Array(n).fill(1);
  let min = 1;
  for (let k = n - 1; k >= 0; k -= 1) { const [p, i] = idx[k]; min = Math.min(min, (p * n) / (k + 1)); q[i] = Math.min(1, min); }
  return q;
}

function median(x: number[]) { if (!x.length) return 0; const s = [...x].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function corr(a: number[], b: number[]) {
  const n = a.length; if (n < 5) return null;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i += 1) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa && sbb ? Math.round(sab / Math.sqrt(saa * sbb) * 100) / 100 : null;
}
const r1 = (v: number) => Math.round(v * 10) / 10;

export const MIN_MARKETS = 20;

/** Analyse one wallet. `splitTs` divides the window into "discovery" and "held-out" parts. */
export function analyzeWallet(wallet: string, fills: Fill[], res: Map<string, Resolution>, splitTs: number, opts: { name?: string | null; nonTradeActivity?: number; sims?: number } = {}): WalletSkill {
  const pos = positionsFrom(fills, res);
  const reasons: string[] = [];
  const cost = pos.reduce((a, p) => a + p.cost, 0);
  const pnl = pos.reduce((a, p) => a + p.pnl, 0);
  const wins = pos.filter((p) => p.pnl > 0).length;
  const avgEntry = cost ? pos.reduce((a, p) => a + p.avgPrice * p.cost, 0) / cost : 0;
  const brier = pos.length ? pos.reduce((a, p) => a + (p.payoff - p.avgPrice), 0) / pos.length : 0;
  const early = pos.filter((p) => p.firstTs < splitTs), late = pos.filter((p) => p.firstTs >= splitTs);
  const lateCost = late.reduce((a, p) => a + p.cost, 0);
  const maxShare = pnl > 0 ? Math.max(0, ...pos.map((p) => p.pnl)) / pnl * 100 : 100;
  const hours = pos.map((p) => p.hoursBeforeEnd).filter((h): h is number => h != null);
  const sizes = pos.map((p) => p.cost), rets = pos.map((p) => p.pnl / p.cost);

  let style = "Mixed";
  if (avgEntry >= 0.85) style = "Favourite sniper (buys near-certainties)";
  else if (avgEntry <= 0.25) style = "Longshot hunter";
  else if (hours.length && median(hours) <= 24) style = "Late / news-reactive";
  const nonTrade = opts.nonTradeActivity ?? 0;

  const base = {
    wallet, name: opts.name ?? null, markets: pos.length, wins, winRatePct: pos.length ? r1(wins / pos.length * 100) : 0,
    cost: Math.round(cost), pnl: Math.round(pnl), roiPct: cost ? r1(pnl / cost * 100) : 0,
    avgEntryPrice: Math.round(avgEntry * 1000) / 1000, impliedWinRatePct: r1(avgEntry * 100), brierEdge: Math.round(brier * 1000) / 1000,
    largestShareOfPnlPct: r1(maxShare), medianBetUsd: Math.round(median(sizes)), sizeSkillCorr: corr(sizes.map(Math.log), rets),
    medianHoursBeforeEnd: hours.length ? r1(median(hours)) : null, lastDayEntriesPct: hours.length ? r1(hours.filter((h) => h <= 24).length / hours.length * 100) : 0,
    style, lateMarkets: late.length, lateRoiPct: lateCost ? r1(late.reduce((a, p) => a + p.pnl, 0) / lateCost * 100) : null,
  };
  if (nonTrade > fills.length * 0.3) {
    reasons.push("Mostly splits/merges/rewards — a market maker or liquidity farmer; P&L comes from spreads and rebates, not predictions.");
    return { ...base, pLuck: 1, earlyP: null, lateP: null, verdict: "EXCLUDED", reasons };
  }
  if (pos.length < MIN_MARKETS) {
    reasons.push(`Only ${pos.length} resolved markets in the window (need ${MIN_MARKETS}).`);
    return { ...base, pLuck: 1, earlyP: null, lateP: null, verdict: "TOO FEW MARKETS", reasons };
  }
  const sims = opts.sims ?? 4000;
  const pLuck = luckPValue(pos, sims);
  const earlyP = early.length >= 10 ? luckPValue(early, sims, 11) : null;
  const lateP = late.length >= 8 ? luckPValue(late, sims, 13) : null;
  if (maxShare > 50) reasons.push(`One market made ${r1(maxShare)}% of the profit — a single big call, not a repeatable edge.`);
  if (style.startsWith("Favourite")) reasons.push("Buys at 85¢+ — small, frequent wins with rare large losses; a few upsets can erase months.");
  return { ...base, pLuck: Math.round(pLuck * 10_000) / 10_000, earlyP, lateP, verdict: "LUCK / NOT SIGNIFICANT", reasons };
}

/** Applies multiple-testing correction and the held-out rule across all scanned wallets. */
export function finalizeVerdicts(ws: WalletSkill[], fdr = 0.05) {
  const tested = ws.filter((w) => w.verdict === "LUCK / NOT SIGNIFICANT");
  const q = bhQValues(tested.map((w) => w.pLuck));
  tested.forEach((w, i) => {
    w.qValue = Math.round(q[i] * 10_000) / 10_000;
    if (q[i] > fdr || w.pnl <= 0) { w.verdict = "LUCK / NOT SIGNIFICANT"; if (w.pnl > 0) w.reasons.push(`After correcting for ${tested.length} wallets tested, luck explains this (q = ${w.qValue}).`); return; }
    if (w.largestShareOfPnlPct > 50) { w.verdict = "SKILL? NOT CONFIRMED"; return; }
    if (w.lateP != null && w.lateP < 0.1 && (w.lateRoiPct ?? 0) > 0) { w.verdict = "SKILL — HELD OUT"; w.reasons.push(`Still ahead of luck in the final third it was not selected on (p = ${Math.round(w.lateP * 1000) / 1000}).`); }
    else { w.verdict = "SKILL? NOT CONFIRMED"; w.reasons.push(w.lateP == null ? "Too few markets in the held-out final third to confirm." : `Edge faded in the held-out final third (p = ${Math.round(w.lateP * 1000) / 1000}).`); }
  });
  const order = { "SKILL — HELD OUT": 0, "SKILL? NOT CONFIRMED": 1, "LUCK / NOT SIGNIFICANT": 2, "TOO FEW MARKETS": 3, EXCLUDED: 4 } as const;
  return [...ws].sort((a, b) => order[a.verdict] - order[b.verdict] || a.pLuck - b.pLuck);
}
