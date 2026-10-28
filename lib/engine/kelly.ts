// Kelly sizing for exchange bets (V6.0). Pure.
//
// Full Kelly maximises long-run growth only if your probability is exactly right. It never is,
// so we (1) blend the model's probability with the market's, (2) bet a fraction of Kelly
// (default ¼), and (3) cap each bet and each market. Commission is charged on net winnings.

export type Side = "BACK" | "LAY";
export type KellyOptions = { fraction?: number; maxBetPct?: number; minEdgePct?: number; commission?: number };

/** Probability after shrinking the model toward the market (w = trust in the model). */
export function blendProbability(model: number, market: number, w = 0.5) {
  return Math.min(0.99, Math.max(0.01, w * model + (1 - w) * market));
}

/** Expected return per £1 risked (stake for BACK, liability for LAY), after commission. */
export function edge(side: Side, p: number, odds: number, commission = 0.05) {
  if (side === "BACK") return p * (odds - 1) * (1 - commission) - (1 - p);
  const winPerLiability = (1 - commission) / (odds - 1);
  return (1 - p) * winPerLiability - p;
}

/** Kelly fraction of bankroll to RISK (stake for BACK, liability for LAY). Never negative. */
export function kellyFraction(side: Side, p: number, odds: number, commission = 0.05) {
  if (!(odds > 1) || !(p > 0 && p < 1)) return 0;
  const b = side === "BACK" ? (odds - 1) * (1 - commission) : (1 - commission) / (odds - 1);
  const win = side === "BACK" ? p : 1 - p;
  return Math.max(0, (b * win - (1 - win)) / b);
}

export function sizeBet(input: { side: Side; p: number; odds: number; bankroll: number; minStake?: number } & KellyOptions) {
  const given = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as typeof input;
  const o = { fraction: 0.25, maxBetPct: 2, minEdgePct: 3, commission: 0.05, minStake: 1, ...given };
  const e = edge(o.side, o.p, o.odds, o.commission);
  const full = kellyFraction(o.side, o.p, o.odds, o.commission);
  if (e * 100 < o.minEdgePct || full <= 0) return { risk: 0, stake: 0, edgePct: round(e * 100), fullKellyPct: round(full * 100), reason: `Edge ${round(e * 100)}% below the ${o.minEdgePct}% bar after commission.` };
  const riskPct = Math.min(full * o.fraction, o.maxBetPct / 100);
  let risk = Math.floor(o.bankroll * riskPct * 100) / 100;
  // A BACK stake is the risk; a LAY stake is liability ÷ (odds − 1).
  let stake = o.side === "BACK" ? risk : Math.floor((risk / (o.odds - 1)) * 100) / 100;
  if (stake < o.minStake) return { risk: 0, stake: 0, edgePct: round(e * 100), fullKellyPct: round(full * 100), reason: `Kelly stake ${stake.toFixed(2)} is below the exchange minimum ${o.minStake}.` };
  if (o.side === "LAY") risk = Math.round(stake * (o.odds - 1) * 100) / 100;
  stake = Math.round(stake * 100) / 100;
  return { risk, stake, edgePct: round(e * 100), fullKellyPct: round(full * 100), reason: `¼-Kelly of ${round(full * 100)}% (capped at ${o.maxBetPct}%).` };
}

function round(v: number) { return Math.round(v * 100) / 100; }

/** Betfair price ladder: round to a valid tick (down for BACK = take what's offered). */
export function toTick(price: number, dir: "down" | "up" = "down") {
  const bands: Array<[number, number, number]> = [[1.01, 2, 0.01], [2, 3, 0.02], [3, 4, 0.05], [4, 6, 0.1], [6, 10, 0.2], [10, 20, 0.5], [20, 30, 1], [30, 50, 2], [50, 100, 5], [100, 1000, 10]];
  const p = Math.min(1000, Math.max(1.01, price));
  for (const [lo, hi, step] of bands) {
    if (p >= lo && p <= hi) {
      const n = (p - lo) / step;
      const k = dir === "down" ? Math.floor(n + 1e-9) : Math.ceil(n - 1e-9);
      return Math.round((lo + k * step) * 100) / 100;
    }
  }
  return p;
}
