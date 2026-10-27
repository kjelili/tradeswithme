import type { Metadata } from "next";
import Dashboard from "@/components/dashboard";
import ExecutionPanel from "@/components/execution-panel";
import ReplayPanel from "@/components/replay-panel";
import DeskInsights from "@/components/desk-insights";
import LabPanel from "@/components/lab-panel";

export const metadata: Metadata = {
  title: "Owner desk",
  robots: { index: false, follow: false },
};

export default function DeskPage() {
  return (
    <>
      <Dashboard />
      <div className="shell"><ExecutionPanel /><DeskInsights /><ReplayPanel /><LabPanel /></div>
    </>
  );
}
