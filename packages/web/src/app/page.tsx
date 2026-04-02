import type { Metadata } from "next";
import { Dashboard } from "@/components/Dashboard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Spur | Dashboard" },
};

export default function Home() {
  return <Dashboard />;
}

