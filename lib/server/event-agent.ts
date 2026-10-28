// Event agent runner (V6.0): Betfair Exchange (UK-regulated). Paper by default.
// Each cycle: settle → scan markets → cross-outcome arbitrage → news + model on the busiest
// markets → mispricing → fractional-Kelly bet (paper, or live once the evidence gate opens).
import { findArbitrage, type Arb } from "@/lib/engine/arbitrage";
import { buildEventPrompt, findMispricing, liveGate, marketProbabilities, parseModelView, settle, type BetIdea, type MarketView } from "@/lib/engine/event-agent";
import { createBetfairClient, betfairConfig, toMarketView, type BetfairClient } from "@/lib/execution/betfair";
import { loadExecState } from "@/lib/execution/ledger";
import { sendAlert } from "@/lib/execution/alerts";
import { complete, llmAgents } from "@/lib/execution/llm";
import { headlines, newsQuery } from "./news";
import { loadReport as loadPolymarket, smartMoneyFor } from "./polymarket";
import { supabaseConfig, supabaseError, supabaseFetch, supabaseHeaders } from "./supabase";

const on = (v?: string) => ["1", "true", "on", "yes"].includes((v ?? "").trim().toLowerCase());
const n = (v: string | undefined, d: number) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : d; };

export function eventSettings(env: NodeJS.ProcessEnv = process.env) {
  const mode = (env.EVENT_AGENT_MODE ?? "off").trim().toLowerCase();
  return {
    mode: (mode === "live" ? "LIVE" : mode === "paper" ? "PAPER" : "OFF") as "OFF" | "PAPER" | "LIVE",
    eventTypes: (env.EVENT_TYPES ?? "1,2378961").split(",").map((s) => s.trim()).filter(Boolean), // 1 = football, 2378961 = politics
    maxModelMarkets: Math.min(20, n(env.EVENT_MAX_MARKETS, 8)),
    paperBankroll: n(env.EVENT_PAPER_BANKROLL_GBP, 100),
    liveCap: Math.min(n(env.EVENT_LIVE_CAP_GBP, 50), 1000),
    kelly: { fraction: Math.min(1, n(env.EVENT_KELLY_FRACTION, 0.25)), maxBetPct: Math.min(10, n(env.EVENT_MAX_BET_PCT, 2)), minEdgePct: n(env.EVENT_MIN_EDGE_PCT, 3), commission: n(env.BETFAIR_COMMISSION, 0.05), minStake: n(env.BETFAIR_MIN_STAKE, 1) },
    arbLive: on(env.EVENT_ARB_LIVE),
    llm: (env.EVENT_LLM ?? "claude").trim().toLowerCase(),
    killSwitch: on(env.TRADING_KILL_SWITCH),
  };
}

async function db<T>(path: string, init: RequestInit = {}, prefer = "return=representation"): Promise<T> {
  const config = supabaseConfig();
  if (!config) throw new Error("Supabase is not configured.");
  const res = await supabaseFetch(`${config.url}/rest/v1/${path}`, { ...init, headers: supabaseHeaders(config, { Prefer: prefer }), cache: "no-store" });
  if (!res.ok) throw new Error(await supabaseError(res, "Event agent storage failed"));
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export type EventBet = {
  id?: string; created_at?: string; mode: "PAPER" | "LIVE"; kind: "VALUE" | "ARB"; arb_group?: string | null;
  market_id: string; market_name: string; event_name: string; start_time: string | null; selection_id: number; runner: string;
  side: "BACK" | "LAY"; price: number; stake: number; risk: number; p_model?: number | null; p_market?: number | null; p_used?: number | null; edge_pct?: number | null;
  reason?: string | null; news?: unknown; status: "OPEN" | "SETTLED" | "VOID" | "REJECTED"; pnl?: number | null; bet_id?: string | null; size_matched?: number | null; customer_ref: string; error?: string | null; settled_at?: string | null;
};

async function openBets() { return db<EventBet[]>(`twm_event_bet?status=eq.OPEN&select=*&limit=500`); }
async function settledBets(mode: "PAPER" | "LIVE") { return db<EventBet[]>(`twm_event_bet?status=eq.SETTLED&mode=eq.${mode}&kind=eq.VALUE&select=pnl,risk&limit=5000`); }

async function settleOpen(client: BetfairClient, commission: number) {
  const open = await openBets();
  const ids = [...new Set(open.map((b) => b.market_id))];
  let settledCount = 0;
  for (let i = 0; i < ids.length; i += 20) {
    const books = await client.books(ids.slice(i, i + 20));
    for (const b of books) {
      if (b.status !== "CLOSED") continue;
      for (const bet of open.filter((x) => x.market_id === b.marketId)) {
        const r = b.runners.find((x) => x.selectionId === bet.selection_id);
        const st = r?.status;
        const stake = bet.mode === "LIVE" ? (bet.size_matched ?? 0) : bet.stake;
        const patch = st === "WINNER" || st === "LOSER"
          ? { status: "SETTLED", pnl: stake > 0 ? settle(bet.side, bet.price, stake, st === "WINNER", commission) : 0, settled_at: new Date().toISOString() }
          : { status: "VOID", pnl: 0, settled_at: new Date().toISOString() };
        await db(`twm_event_bet?id=eq.${bet.id}`, { method: "PATCH", body: JSON.stringify(patch) }, "return=minimal");
        settledCount += 1;
      }
    }
  }
  return settledCount;
}

async function record(rows: EventBet[]) {
  if (!rows.length) return [] as EventBet[];
  return db<EventBet[]>(`twm_event_bet?on_conflict=customer_ref`, { method: "POST", body: JSON.stringify(rows) }, "resolution=ignore-duplicates,return=representation");
}

async function saveViews(rows: unknown[]) {
  if (rows.length) await db(`twm_event_view`, { method: "POST", body: JSON.stringify(rows) }, "return=minimal");
}

function ref(parts: Array<string | number>) {
  // Deterministic per market/selection/side/hour → a re-run within the hour can't double-bet.
  const s = parts.join("|");
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `twm${(h >>> 0).toString(36)}${parts.at(-1)}`.slice(0, 32);
}

export async function runEventAgent(now = new Date()) {
  const s = eventSettings();
  const log: string[] = [];
  if (s.mode === "OFF") return { skipped: "EVENT_AGENT_MODE is off.", log };
  const client = createBetfairClient();
  if (!client) return { skipped: "Betfair is not configured (BETFAIR_APP_KEY / USERNAME / PASSWORD).", log };

  const settledNow = await settleOpen(client, s.kelly.commission).catch((e) => { log.push(`Settle failed: ${e instanceof Error ? e.message : e}`); return 0; });
  if (settledNow) log.push(`Settled ${settledNow} bet(s).`);

  // Live permission: evidence gate on PAPER value bets, kill switches, desk halt.
  const gate = liveGate((await settledBets("PAPER")).map((b) => ({ pnl: b.pnl ?? 0, risk: b.risk })));
  const halted = (await loadExecState().catch(() => null))?.halted ?? false;
  let liveOk = s.mode === "LIVE" && gate.ok && !s.killSwitch && !halted;
  let bankroll = s.paperBankroll;
  if (s.mode === "LIVE") {
    const funds = await client.funds().catch(() => null);
    const open = (await openBets()).filter((b) => b.mode === "LIVE").reduce((a, b) => a + b.risk, 0);
    bankroll = Math.max(0, Math.min(s.liveCap, (funds?.availableToBetBalance ?? 0) + open));
    if (!funds) { liveOk = false; log.push("Could not read Betfair funds — live disabled this cycle."); }
    if (!gate.ok) log.push(`Live gate closed: ${gate.reason} Bets stay on paper.`);
  }

  const from = now.toISOString(), to = new Date(now.getTime() + 48 * 3600_000).toISOString();
  const cats = await client.catalogue({ eventTypeIds: s.eventTypes, marketStartTime: { from, to }, marketBettingTypes: ["ODDS"], inPlayOnly: false }, 60);
  const singleWinner = cats.filter((c) => (c.runners?.length ?? 0) >= 2 && (c.runners?.length ?? 0) <= 16);
  const books = [];
  for (let i = 0; i < singleWinner.length; i += 20) books.push(...await client.books(singleWinner.slice(i, i + 20).map((c) => c.marketId)));
  const views: MarketView[] = books
    .filter((b) => b.status === "OPEN" && !b.inplay && (b.numberOfWinners ?? 1) === 1)
    .map((b) => toMarketView(singleWinner.find((c) => c.marketId === b.marketId)!, b))
    .filter((v) => v.runners.length >= 2);
  log.push(`Scanned ${views.length} open single-winner markets.`);

  const open = await openBets();
  const hasOpen = new Set(open.map((b) => b.market_id));
  const hour = now.toISOString().slice(0, 13);
  const rows: EventBet[] = [];
  const toPlace: Array<{ bet: EventBet; fok: boolean }> = [];
  const mode = liveOk ? "LIVE" : "PAPER";

  // 1) Cross-outcome arbitrage (all runners must be quoted; commission modelled).
  const arbs: Array<{ view: MarketView; arb: Arb }> = [];
  for (const v of views) {
    const arb = findArbitrage(v.runners, Math.min(bankroll * 0.1, 50), { commission: s.kelly.commission, minStake: s.kelly.minStake });
    if (arb) arbs.push({ view: v, arb });
  }
  for (const { view, arb } of arbs.slice(0, 3)) {
    const group = ref([view.marketId, arb.kind, hour]);
    const arbMode = liveOk && s.arbLive ? "LIVE" : "PAPER";
    for (const l of arb.legs) {
      const bet: EventBet = { mode: arbMode, kind: "ARB", arb_group: group, market_id: view.marketId, market_name: view.marketName, event_name: view.eventName, start_time: view.startTime, selection_id: l.selectionId, runner: l.name, side: l.side, price: l.price, stake: l.stake, risk: l.side === "BACK" ? l.stake : Math.round(l.stake * (l.price - 1) * 100) / 100, edge_pct: arb.profitPct, reason: `${arb.kind} book ${arb.bookPct}% → locked ${arb.profit} (${arb.profitPct}%) after commission.`, status: "OPEN", customer_ref: ref([view.marketId, l.selectionId, l.side, "arb", hour]) };
      rows.push(bet);
      if (arbMode === "LIVE") toPlace.push({ bet, fok: true });
    }
    log.push(`Arbitrage in ${view.eventName} / ${view.marketName}: ${arb.kind} ${arb.profitPct}%.`);
  }

  // 2) News + model on the busiest markets without an open bet.
  const { agents } = llmAgents();
  const llm = agents.find((a) => a.id === s.llm) ?? agents[0];
  const pm = await loadPolymarket().catch(() => null);
  const viewRows: unknown[] = [];
  if (!llm) log.push("No language model configured (ANTHROPIC_* or XAI_*) — value bets skipped; arbitrage still scanned.");
  else {
    const targets = views.filter((v) => !hasOpen.has(v.marketId)).sort((a, b) => (b.totalMatched ?? 0) - (a.totalMatched ?? 0)).slice(0, s.maxModelMarkets);
    await Promise.all(targets.map(async (v) => {
      const q = newsQuery(v.eventName, v.marketName);
      const news = q ? await headlines(q, 24, 10) : [];
      const smart = pm ? smartMoneyFor(pm.flow, v.eventName, v.marketName) : [];
      const prompt = buildEventPrompt(v, news, smart);
      try {
        const text = await complete(llm, prompt.system, prompt.user, fetch, 60_000);
        const parsed = parseModelView(text, v.runners);
        if ("error" in parsed) { viewRows.push({ market_id: v.marketId, market_name: v.marketName, event_name: v.eventName, model: llm.model, error: parsed.error, headlines: news.slice(0, 5) }); return; }
        const idea: BetIdea | null = findMispricing(v, parsed, bankroll, s.kelly);
        viewRows.push({ market_id: v.marketId, market_name: v.marketName, event_name: v.eventName, model: llm.model, confidence: parsed.confidence, reason: parsed.reason, probabilities: parsed.probabilities, market_probabilities: Object.fromEntries(v.runners.map((r, i) => [r.selectionId, Math.round(marketProbabilities(v.runners)[i] * 1000) / 1000])), runners: v.runners.map((r) => ({ id: r.selectionId, name: r.name })), headlines: news.slice(0, 5), smart_money: smart, idea });
        if (idea) {
          const bet: EventBet = { mode, kind: "VALUE", market_id: v.marketId, market_name: v.marketName, event_name: v.eventName, start_time: v.startTime, selection_id: idea.selectionId, runner: idea.runner, side: idea.side, price: idea.price, stake: idea.stake, risk: idea.risk, p_model: idea.pModel, p_market: idea.pMarket, p_used: idea.pUsed, edge_pct: idea.edgePct, reason: idea.reason, news: news.filter((_, i) => parsed.newsUsed.includes(i)).slice(0, 5), status: "OPEN", customer_ref: ref([v.marketId, idea.selectionId, idea.side, hour]) };
          rows.push(bet);
          if (mode === "LIVE") toPlace.push({ bet, fok: false });
        }
      } catch (e) {
        viewRows.push({ market_id: v.marketId, market_name: v.marketName, event_name: v.eventName, model: llm.model, error: e instanceof Error ? e.message.slice(0, 200) : "model failed" });
      }
    }));
  }
  await saveViews(viewRows).catch((e) => log.push(`View log failed: ${e instanceof Error ? e.message : e}`));

  // 3) Record first (unique customer_ref), then place only rows that were newly inserted.
  const inserted = await record(rows);
  const newRefs = new Set(inserted.map((r) => r.customer_ref));
  const liveExposure = open.filter((b) => b.mode === "LIVE").reduce((a, b) => a + b.risk, 0);
  let budget = Math.max(0, s.liveCap - liveExposure);
  for (const { bet, fok } of toPlace) {
    const row = inserted.find((r) => r.customer_ref === bet.customer_ref);
    if (!row || !newRefs.has(bet.customer_ref)) continue;
    if (bet.risk > budget) { await db(`twm_event_bet?id=eq.${row.id}`, { method: "PATCH", body: JSON.stringify({ status: "REJECTED", error: "Live cap reached." }) }, "return=minimal"); continue; }
    try {
      const r = await client.place(bet.market_id, bet.customer_ref, [{ selectionId: bet.selection_id, side: bet.side, price: bet.price, size: bet.stake, fillOrKill: fok }]);
      const rep = r.instructionReports?.[0];
      const ok = r.status === "SUCCESS";
      await db(`twm_event_bet?id=eq.${row.id}`, { method: "PATCH", body: JSON.stringify(ok ? { bet_id: rep?.betId ?? null, size_matched: rep?.sizeMatched ?? 0 } : { status: "REJECTED", error: `${r.errorCode ?? r.status} ${rep?.errorCode ?? ""}`.trim() }) }, "return=minimal");
      if (ok) budget -= bet.risk;
      log.push(`${ok ? "Placed" : "Rejected"} LIVE ${bet.side} ${bet.stake} @ ${bet.price} on ${bet.runner}${ok ? ` (matched ${rep?.sizeMatched ?? 0})` : ` — ${r.errorCode ?? ""}`}.`);
    } catch (e) {
      // Ambiguous (e.g. timeout): leave OPEN with an error; never resubmit — customerRef also blocks duplicates.
      await db(`twm_event_bet?id=eq.${row.id}`, { method: "PATCH", body: JSON.stringify({ error: `Placement uncertain: ${e instanceof Error ? e.message.slice(0, 160) : "error"}. Check Betfair.` }) }, "return=minimal");
    }
  }
  const valueNew = inserted.filter((r) => r.kind === "VALUE");
  if (valueNew.length || arbs.length) await sendAlert(`Event agent: ${valueNew.length} value bet(s), ${arbs.length} arbitrage(s) — ${mode}`, [...log, ...valueNew.map((b) => `${b.mode} ${b.side} ${b.runner} @ ${b.price} · stake ${b.stake} · edge ${b.edge_pct}% · ${b.event_name}`)]);
  return { mode, liveOk, gate: gate.reason, bankroll, markets: views.length, arbs: arbs.length, valueBets: valueNew.length, log };
}

export async function loadEventAgent() {
  const s = eventSettings();
  const cfg = betfairConfig();
  const { agents } = llmAgents();
  if (!supabaseConfig()) return { settings: s, configured: Boolean(cfg), llm: null, open: [], recent: [], views: [], stats: null };
  const [open, recent, views, paper, live] = await Promise.all([
    openBets(),
    db<EventBet[]>(`twm_event_bet?status=neq.OPEN&select=*&order=created_at.desc&limit=40`),
    db<unknown[]>(`twm_event_view?select=*&order=created_at.desc&limit=20`),
    settledBets("PAPER"), settledBets("LIVE"),
  ]);
  const st = (rows: EventBet[]) => {
    const risk = rows.reduce((a, b) => a + b.risk, 0), pnl = rows.reduce((a, b) => a + (b.pnl ?? 0), 0);
    return { bets: rows.length, pnl: Math.round(pnl * 100) / 100, roiPct: risk ? Math.round(pnl / risk * 1000) / 10 : 0 };
  };
  return {
    settings: { ...s, kelly: s.kelly }, configured: Boolean(cfg), llm: (agents.find((a) => a.id === s.llm) ?? agents[0])?.label ?? null,
    gate: liveGate(paper.map((b) => ({ pnl: b.pnl ?? 0, risk: b.risk }))), open, recent, views, stats: { paper: st(paper), live: st(live) },
  };
}
