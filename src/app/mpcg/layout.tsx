import type { Metadata } from "next";
import { Jost } from "next/font/google";
import "./mpcg.css";

// The landing page's own typeface (distinct from the portal chrome).
const jost = Jost({
  variable: "--mpcg-jost",
  subsets: ["latin"],
  weight: ["200", "300", "400", "500", "600"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "MPCG — From dirt to sold out",
  description:
    "MPCG builds the brand, the website, and the campaigns — anchored by SiteView, an interactive 3D map that turns your master plan into your best salesperson.",
};

export default function MpcgLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`mpcg ${jost.variable}`}>
      {children}
    </div>
  );
}
