// Cross-outcome arbitrage on an exchange market (V6.0). Pure.
//
// In a market where exactly one runner wins, backing EVERY runner at prices whose implied
// probabilities sum below 1 locks in a profit (a "dutch"); laying every runner where they sum
// above 1 does the same from the other side. Commission is charged on the net market win,
// which is what kills most apparent arbitrages — so we model it.

export type RunnerQuote = { selectionId: number; name: string; back?: { price: number; size: number } | null; lay?: { price: number; size: number } | null };
export type ArbLeg = { selectionId: number; name: string; side: "BACK" | "LAY"; price: number; stake: number };
export type Arb = { kind: "BACK_ALL" | "LAY_ALL"; bookPct: number; legs: ArbLeg[]; outlay: number; profit: number; profitPct: number };

/**
 * `budget`: total money to commit (BACK_ALL: sum of stakes; LAY_ALL: max liability).
 * Requires every runner quoted, each leg ≥ minStake and within the offered size.
 */
export function findArbitrage(runners: RunnerQuote[], budget: number, opts: { commission?: number; minStake?: number; minProfitPct?: number } = {}): Arb | null {
  const c = opts.commission ?? 0.05, minStake = opts.minStake ?? 1, minProfitPct = opts.minProfitPct ?? 0.5;
  if (runners.length < 2) return null;

  // BACK every runner: stake_i ∝ 1/price_i so the return is equal whichever wins.
  if (runners.every((r) => r.back && r.back.price > 1)) {
    const inv = runners.map((r) => 1 / r.back!.price);
    const book = inv.reduce((a, b) => a + b, 0);
    if (book < 1) {
      let legs = runners.map((r, i) => ({ selectionId: r.selectionId, name: r.name, side: "BACK" as const, price: r.back!.price, stake: floor2(budget * inv[i] / book) }));
      // Respect offered liquidity: scale down if any leg wants more than is offered.
      const scale = Math.min(1, ...legs.map((l, i) => runners[i].back!.size / Math.max(l.stake, 1e-9)));
      if (scale < 1) legs = legs.map((l) => ({ ...l, stake: floor2(l.stake * scale) }));
      const outlay = legs.reduce((a, l) => a + l.stake, 0);
      // Worst case over winners: gross return − outlay, commission on positive net.
      const profit = Math.min(...legs.map((l) => { const net = l.stake * l.price - outlay; return net > 0 ? net * (1 - c) : net; }));
      const res = { kind: "BACK_ALL" as const, bookPct: round(book * 100), legs, outlay: round(outlay), profit: round(profit), profitPct: outlay ? round(profit / outlay * 100) : 0 };
      if (legs.every((l) => l.stake >= minStake) && res.profitPct >= minProfitPct) return res;
    }
  }

  // LAY every runner: you win all lay stakes except the winner's liability.
  if (runners.every((r) => r.lay && r.lay.price > 1)) {
    const inv = runners.map((r) => 1 / r.lay!.price);
    const book = inv.reduce((a, b) => a + b, 0);
    if (book > 1) {
      // Equalise outcomes: stake_i = K / price_i. If runner j wins: Σstakes − stake_j·price_j = K·book − K = K(book−1).
      let K = budget; // liability of each winner = stake·(price−1) ≤ K
      let legs = runners.map((r, i) => ({ selectionId: r.selectionId, name: r.name, side: "LAY" as const, price: r.lay!.price, stake: floor2(K * inv[i]) }));
      const scale = Math.min(1, ...legs.map((l, i) => runners[i].lay!.size / Math.max(l.stake, 1e-9)));
      if (scale < 1) { K *= scale; legs = legs.map((l) => ({ ...l, stake: floor2(l.stake * scale) })); }
      const total = legs.reduce((a, l) => a + l.stake, 0);
      const outcomes = legs.map((l) => total - l.stake * l.price);
      const profit = Math.min(...outcomes.map((n) => (n > 0 ? n * (1 - c) : n)));
      // Funds needed: the largest single liability (Betfair nets the other legs against it).
      const outlay = Math.max(...legs.map((l) => l.stake * (l.price - 1)));
      const res = { kind: "LAY_ALL" as const, bookPct: round(book * 100), legs, outlay: round(Math.max(outlay, 0.01)), profit: round(profit), profitPct: round(profit / Math.max(outlay, 0.01) * 100) };
      if (legs.every((l) => l.stake >= minStake) && profit > 0 && res.profitPct >= minProfitPct) return res;
    }
  }
  return null;
}

function floor2(v: number) { return Math.floor(v * 100) / 100; }
function round(v: number) { return Math.round(v * 100) / 100; }
