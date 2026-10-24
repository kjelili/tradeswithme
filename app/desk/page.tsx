import type { Metadata } from "next";
import Dashboard from "@/components/dashboard";

export const metadata: Metadata = {
  title: "Owner desk",
  robots: { index: false, follow: false },
};

export default function DeskPage() {
  return <Dashboard />;
}
