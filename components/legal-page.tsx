import type { ReactNode } from "react";
import { MarketingShell } from "@/components/site-chrome";

export default function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <MarketingShell>
      <article className="mk-legal">
        <h1>{title}</h1>
        <p className="mk-legal-updated">Last updated {updated}</p>
        {children}
      </article>
    </MarketingShell>
  );
}
