import type { Metadata } from "next";
import Dashboard from "@/components/dashboard";
import ExecutionPanel from "@/components/execution-panel";
import ReplayPanel from "@/components/replay-panel";
import DeskInsights from "@/components/desk-insights";
import LabPanel from "@/components/lab-panel";
import StrategiesPanel from "@/components/strategies-panel";
import RebalancePanel from "@/components/rebalance-panel";
import ArenaPanel from "@/components/arena-panel";
import EventAgentPanel from "@/components/event-agent-panel";
import PolymarketPanel from "@/components/polymarket-panel";

export const metadata: Metadata = {
  title: "Owner desk",
  robots: { index: false, follow: false },
};

export default function DeskPage() {
  return (
    <>
      <Dashboard />
      <div className="shell"><StrategiesPanel /><RebalancePanel /><ArenaPanel /><EventAgentPanel /><PolymarketPanel /><ExecutionPanel /><DeskInsights /><ReplayPanel /><LabPanel /></div>
    </>
  );
}
