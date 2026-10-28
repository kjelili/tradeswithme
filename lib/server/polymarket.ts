// Polymarket wallet scanner (V6.0). READ-ONLY public data — no account, no orders.
// UK residents are close-only on Polymarket, so this is research: who has a real edge, and
// what is that "smart money" buying now (fed to the event agent as context).
import { analyzeWallet, finalizeVerdicts, type Fill, type Resolution, type WalletSkill } from "@/lib/engine/wallet-skill";
import { supabaseConfig, supabaseError, supabaseFetch, supabaseHeaders } from "./supabase";

const DATA = "https://data-api.polymarket.com/v2";
const GAMMA = "https://gamma-api.polymarket.com";
const WINDOW_DAYS = 120;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(url: string, tries = 3): Promise<T> {
  for (let i = 0; i < tries; i += 1) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(url, { signal: controller.signal, cache: "no-store", headers: { Accept: "application/json", "User-Agent": "TradesWithMe/6.0 research" } });
      if (res.status === 429) { await sleep(Math.min(30, Number(res.headers.get("retry-after") ?? 3)) * 1000); continue; }
      if (!res.ok) throw new Error(`${new URL(url).pathname} → ${res.status}`);
      return await res.json() as T;
    } finally { clearTimeout(t); }
  }
  throw new Error(`${new URL(url).pathname}: rate-limited`);
}

async function db<T>(path: string, init: RequestInit = {}, prefer = "return=representation"): Promise<T> {
  const config = supabaseConfig();
  if (!config) throw new Error("Supabase is not configured.");
  const res = await supabaseFetch(`${config.url}/rest/v1/${path}`, { ...init, headers: supabaseHeaders(config, { Prefer: prefer }), cache: "no-store" });
  if (!res.ok) throw new Error(await supabaseError(res, "Polymarket scan storage failed"));
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

type Row = Record<string, unknown>;
const str = (r: Row, ...k: string[]) => { for (const x of k) if (typeof r[x] === "string" && r[x]) return r[x] as string; return null; };
const num = (r: Row, ...k: string[]) => { for (const x of k) { const v = Number(r[x]); if (r[x] != null && Number.isFinite(v)) return v; } return 0; };

export async function leaderboard(limit = 150) {
  const seen = new Map<string, { wallet: string; name: string | null; pnl: number }>();
  let sampleKeys: string[] = [];
  for (const period of ["month", "all"]) {
    const j = await getJson<{ data?: Row[] }>(`${DATA}/leaderboard?time_period=${period}&sort_by=PNL&limit=${limit}`);
    if (!sampleKeys.length && j.data?.[0]) sampleKeys = Object.keys(j.data[0]);
    for (const r of j.data ?? []) {
      const wallet = str(r, "proxy_wallet", "user_id", "proxyWallet", "wallet", "address");
      if (wallet && /^0x[0-9a-fA-F]{40}$/.test(wallet) && !seen.has(wallet.toLowerCase())) seen.set(wallet.toLowerCase(), { wallet: wallet.toLowerCase(), name: str(r, "user_name", "userName", "name"), pnl: num(r, "pnl") });
    }
  }
  if (!seen.size) throw new Error(`Leaderboard returned no wallet addresses${sampleKeys.length ? ` (row fields: ${sampleKeys.join(", ")})` : ""} — the API shape may have changed.`);
  return [...seen.values()];
}

export async function walletActivity(wallet: string, startTs: number, maxPages = 6) {
  const fills: Fill[] = [];
  let nonTrade = 0, cursor: string | null = null;
  for (let p = 0; p < maxPages; p += 1) {
    const q: string = `${DATA}/activity?user=${wallet}&start=${startTs}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const j = await getJson<{ data?: Row[]; pagination?: { next_cursor?: string | null } }>(q);
    for (const r of j.data ?? []) {
      const type = String(r.type ?? "").toUpperCase();
      if (type !== "TRADE") { if (["SPLIT", "MERGE", "REWARD", "CONVERSION"].includes(type)) nonTrade += 1; continue; }
      const side = String(r.side ?? "").toUpperCase();
      const conditionId = str(r, "condition_id", "conditionId");
      if (!conditionId || (side !== "BUY" && side !== "SELL")) continue;
      fills.push({ conditionId, outcomeIndex: num(r, "outcome_index", "outcomeIndex"), side, price: num(r, "price"), size: num(r, "size"), usdc: num(r, "usdc_size", "usdcSize"), timestamp: num(r, "timestamp"), title: str(r, "title") ?? undefined });
    }
    cursor = j.pagination?.next_cursor ?? null;
    if (!cursor) break;
    await sleep(250);
  }
  return { fills, nonTrade };
}

/** Resolution of each market from Gamma, cached in Supabase. */
export async function resolutions(conditionIds: string[]) {
  const out = new Map<string, Resolution>();
  const ids = [...new Set(conditionIds)];
  if (!ids.length) return out;
  const cached = supabaseConfig() ? await db<Array<{ condition_id: string; winning_index: number | null; end_ts: number | null; title: string | null }>>(`twm_pm_market?select=*&winning_index=not.is.null&condition_id=in.(${ids.slice(0, 2000).map((x) => `"${x}"`).join(",")})`).catch(() => []) : [];
  for (const c of cached) out.set(c.condition_id, { conditionId: c.condition_id, winningIndex: c.winning_index, endTs: c.end_ts, title: c.title ?? undefined });
  const missing = ids.filter((x) => !out.has(x));
  const fresh: Array<{ condition_id: string; winning_index: number | null; end_ts: number | null; title: string | null; updated_at: string }> = [];
  for (let i = 0; i < missing.length; i += 40) {
    const chunk = missing.slice(i, i + 40);
    const j = await getJson<Row[]>(`${GAMMA}/markets?limit=100&closed=true&${chunk.map((c) => `condition_ids=${c}`).join("&")}`).catch(() => [] as Row[]);
    for (const m of Array.isArray(j) ? j : []) {
      const cid = str(m, "conditionId", "condition_id");
      if (!cid) continue;
      let prices: number[] = [];
      try { const raw = m.outcomePrices; prices = (typeof raw === "string" ? JSON.parse(raw) : raw as unknown[]).map(Number); } catch { /* unresolved */ }
      const w = m.closed === true ? prices.findIndex((p) => p >= 0.99) : -1;
      const end = str(m, "endDate", "end_date");
      const row = { condition_id: cid, winning_index: w >= 0 ? w : null, end_ts: end ? Math.floor(new Date(end).getTime() / 1000) : null, title: str(m, "question", "title"), updated_at: new Date().toISOString() };
      fresh.push(row);
      out.set(cid, { conditionId: cid, winningIndex: row.winning_index, endTs: row.end_ts, title: row.title ?? undefined });
    }
    await sleep(200);
  }
  if (fresh.length && supabaseConfig()) await db(`twm_pm_market?on_conflict=condition_id`, { method: "POST", body: JSON.stringify(fresh) }, "resolution=merge-duplicates,return=minimal").catch(() => null);
  return out;
}

type ScanState = { id: string; started_at: string; window_start: number; split_ts: number; queue: Array<{ wallet: string; name: string | null }>; total: number; flow: unknown; flow_at: string | null };

async function loadState(): Promise<ScanState | null> {
  const rows = await db<ScanState[]>(`twm_pm_scan?id=eq.current&select=*`);
  return rows[0] ?? null;
}
async function saveState(s: Partial<ScanState>) {
  await db(`twm_pm_scan?on_conflict=id`, { method: "POST", body: JSON.stringify({ id: "current", ...s }) }, "resolution=merge-duplicates,return=minimal");
}

/** Starts a fresh 120-day scan of the top wallets. */
export async function startScan(limit = 150) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - WINDOW_DAYS * 86400;
  const wallets = await leaderboard(limit);
  // Split: the last third of the window is held out to confirm what the first two-thirds found.
  await saveState({ started_at: new Date().toISOString(), window_start: windowStart, split_ts: windowStart + Math.round(WINDOW_DAYS * 86400 * 2 / 3), queue: wallets.map(({ wallet, name }) => ({ wallet, name })), total: wallets.length });
  return { queued: wallets.length };
}

/** Processes the next batch within a time budget. Call repeatedly (cron / button). */
export async function continueScan(budgetMs = 200_000) {
  const t0 = Date.now();
  const s = await loadState();
  if (!s) return { done: 0, remaining: 0, note: "No scan started." };
  const queue = [...(s.queue ?? [])];
  let done = 0;
  while (queue.length && Date.now() - t0 < budgetMs) {
    const w = queue[0];
    try {
      const { fills, nonTrade } = await walletActivity(w.wallet, s.window_start);
      const res = await resolutions(fills.map((f) => f.conditionId));
      const result = analyzeWallet(w.wallet, fills, res, s.split_ts, { name: w.name, nonTradeActivity: nonTrade, sims: 3000 });
      await db(`twm_pm_wallet?on_conflict=wallet`, { method: "POST", body: JSON.stringify({ wallet: w.wallet, scan_started: s.started_at, result, updated_at: new Date().toISOString() }) }, "resolution=merge-duplicates,return=minimal");
    } catch (e) {
      console.warn(`[polymarket] ${w.wallet}: ${e instanceof Error ? e.message : e}`);
    }
    queue.shift(); done += 1;
    await saveState({ queue });
  }
  if (!queue.length && (!s.flow_at || Date.now() - new Date(s.flow_at).getTime() > 6 * 3600_000)) await refreshFlow(s.started_at).catch(() => null);
  return { done, remaining: queue.length, total: s.total };
}

export type FlowItem = { title: string; outcomeIndex: number; buyers: number; usdc: number; avgPrice: number; lastTs: number };

/** What wallets with a confirmed edge bought in the last 3 days. */
async function refreshFlow(started: string) {
  const report = await loadReport(started);
  const skilled = report.wallets.filter((w) => w.verdict === "SKILL — HELD OUT").slice(0, 20);
  const since = Math.floor(Date.now() / 1000) - 3 * 86400;
  const agg = new Map<string, FlowItem & { wallets: Set<string>; px: number }>();
  for (const w of skilled) {
    const { fills } = await walletActivity(w.wallet, since, 1);
    for (const f of fills.filter((x) => x.side === "BUY")) {
      const k = `${f.conditionId}:${f.outcomeIndex}`;
      const a = agg.get(k) ?? { title: f.title ?? f.conditionId, outcomeIndex: f.outcomeIndex, buyers: 0, usdc: 0, avgPrice: 0, lastTs: 0, wallets: new Set<string>(), px: 0 };
      a.wallets.add(w.wallet); a.usdc += f.usdc; a.px += f.price * f.usdc; a.lastTs = Math.max(a.lastTs, f.timestamp);
      agg.set(k, a);
    }
  }
  const flow = [...agg.values()].map(({ wallets, px, ...a }) => ({ ...a, buyers: wallets.size, usdc: Math.round(a.usdc), avgPrice: a.usdc ? Math.round(px / a.usdc * 1000) / 1000 : 0 }))
    .sort((a, b) => b.buyers - a.buyers || b.usdc - a.usdc).slice(0, 40);
  await saveState({ flow, flow_at: new Date().toISOString() });
}

export async function loadReport(started?: string) {
  if (!supabaseConfig()) return { state: null, wallets: [] as WalletSkill[], flow: [] as FlowItem[] };
  const s = await loadState();
  const scanStart = started ?? s?.started_at;
  const rows = scanStart ? await db<Array<{ result: WalletSkill }>>(`twm_pm_wallet?select=result&scan_started=eq.${encodeURIComponent(scanStart)}&limit=2000`) : [];
  const wallets = finalizeVerdicts(rows.map((r) => r.result));
  return {
    state: s ? { startedAt: s.started_at, windowStart: s.window_start, splitTs: s.split_ts, total: s.total, remaining: s.queue?.length ?? 0, flowAt: s.flow_at } : null,
    wallets, flow: (s?.flow as FlowItem[] | null) ?? [],
  };
}

/** Short "smart money" lines for the event agent's prompt, matched by shared words. */
export function smartMoneyFor(flow: FlowItem[], eventName: string, marketName: string) {
  const words = new Set(`${eventName} ${marketName}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  if (!words.size) return [];
  return flow.filter((f) => {
    const t = f.title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    const hit = t.filter((w) => words.has(w)).length;
    return hit >= Math.min(2, words.size);
  }).slice(0, 5).map((f) => `Polymarket: ${f.buyers} edge-confirmed wallet(s) bought outcome #${f.outcomeIndex} of "${f.title}" — $${f.usdc} at avg ${Math.round(f.avgPrice * 100)}¢ in the last 3 days.`);
}
