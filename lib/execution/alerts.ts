// Optional email alerts via Resend (RESEND_API_KEY + ALERT_EMAIL). Never throws:
// a failed alert must not break order management.

export async function sendAlert(subject: string, lines: string[], fetchImpl: typeof fetch = fetch) {
  const key = process.env.RESEND_API_KEY?.trim();
  const to = process.env.ALERT_EMAIL?.trim();
  const text = lines.join("\n");
  console.log(`[TWM ALERT] ${subject}\n${text}`);
  if (!key || !to) return false;
  try {
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.ALERT_FROM?.trim() || "TradesWithMe <onboarding@resend.dev>", to: [to], subject: `[TradesWithMe] ${subject}`, text }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
