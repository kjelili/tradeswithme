"use client";

import { useState } from "react";

type Props = { interest?: "free" | "founder" | "setup"; source?: string; cta?: string };

export default function WaitlistForm({ interest = "free", source = "home", cta = "Join free" }: Props) {
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (state === "sending") return;
    setState("sending");
    setMessage("");
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, interest, source, company }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(data.error || "Something went wrong.");
      setState("done");
      setMessage(interest === "free" ? "You're in. First weekly results email lands on Monday." : "Seat reserved. We'll email you first when checkout opens.");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Something went wrong.");
    }
  }

  if (state === "done") return <p className="mk-form-ok" role="status">{message}</p>;

  return (
    <form className="mk-form" onSubmit={submit} noValidate>
      <label className="mk-sr" htmlFor={`email-${source}-${interest}`}>Email address</label>
      <input id={`email-${source}-${interest}`} type="email" required autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input className="mk-hp" tabIndex={-1} autoComplete="off" aria-hidden="true" name="company" value={company} onChange={(e) => setCompany(e.target.value)} />
      <button type="submit" disabled={state === "sending"}>{state === "sending" ? "Saving…" : cta}</button>
      {state === "error" && <p className="mk-form-err" role="alert">{message}</p>}
    </form>
  );
}
