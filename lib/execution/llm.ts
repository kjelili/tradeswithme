// Minimal LLM clients for the AI agent arena (V5.9). Text in, text out — no tools, no browsing,
// no ability to act. Every call is time-boxed. Models are configured by env, never guessed.

export type LlmAgentId = "grok" | "claude";
export type LlmConfig = { id: LlmAgentId; label: string; model: string; key: string };

export function llmAgents(env: NodeJS.ProcessEnv = process.env): { agents: LlmConfig[]; missing: string[] } {
  const wanted = (env.ARENA_AGENTS ?? "grok,claude").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const agents: LlmConfig[] = [];
  const missing: string[] = [];
  if (wanted.includes("grok")) {
    const key = env.XAI_API_KEY?.trim(), model = env.XAI_MODEL?.trim();
    if (key && model) agents.push({ id: "grok", label: `Grok (${model})`, model, key });
    else missing.push(`Grok needs ${[!key && "XAI_API_KEY", !model && "XAI_MODEL"].filter(Boolean).join(" + ")}`);
  }
  if (wanted.includes("claude")) {
    const key = env.ANTHROPIC_API_KEY?.trim(), model = env.ANTHROPIC_MODEL?.trim();
    if (key && model) agents.push({ id: "claude", label: `Claude (${model})`, model, key });
    else missing.push(`Claude needs ${[!key && "ANTHROPIC_API_KEY", !model && "ANTHROPIC_MODEL"].filter(Boolean).join(" + ")}`);
  }
  return { agents, missing };
}

async function post(url: string, headers: Record<string, string>, body: unknown, fetchImpl: typeof fetch, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: controller.signal, cache: "no-store" });
    const text = await res.text();
    if (!res.ok) throw new Error(`${new URL(url).host} → ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as unknown;
  } finally { clearTimeout(timer); }
}

export async function complete(cfg: LlmConfig, system: string, user: string, fetchImpl: typeof fetch = fetch, timeoutMs = 90_000): Promise<string> {
  if (cfg.id === "grok") {
    // xAI's API is OpenAI-compatible.
    const json = await post("https://api.x.ai/v1/chat/completions", { Authorization: `Bearer ${cfg.key}` },
      { model: cfg.model, temperature: 0.2, max_tokens: 800, messages: [{ role: "system", content: system }, { role: "user", content: user }] }, fetchImpl, timeoutMs) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? "";
  }
  const json = await post("https://api.anthropic.com/v1/messages", { "x-api-key": cfg.key, "anthropic-version": "2023-06-01" },
    { model: cfg.model, max_tokens: 800, system, messages: [{ role: "user", content: user }] }, fetchImpl, timeoutMs) as { content?: Array<{ type?: string; text?: string }> };
  return (json.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
}
