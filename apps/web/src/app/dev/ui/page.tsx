import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Showcase } from "./showcase";

export const metadata: Metadata = {
  title: "Designsystem",
  robots: { index: false, follow: false },
};

/** /dev/ui – nur in Entwicklung erreichbar (docs/13 Phase 1), in Produktion 404. */
export default function DevUiPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <Showcase />;
}
