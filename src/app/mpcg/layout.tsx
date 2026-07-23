import type { Metadata } from "next";
import { Space_Grotesk, Space_Mono } from "next/font/google";
import "./mpcg.css";

// The landing page's own type system (distinct from the portal chrome).
// One superfamily: Space Grotesk for display/body, its monospace sibling
// Space Mono for the technical labels — a "spec sheet" voice that fits a
// parcel-mapping product and reads architectural rather than AI-luxury.
const grotesk = Space_Grotesk({
  variable: "--mpcg-grotesk",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});
const mono = Space_Mono({
  variable: "--mpcg-mono",
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  title: "MPCG — From dirt to sold out",
  description:
    "MPCG builds the brand, the website, and the campaigns — anchored by SiteView, an interactive 3D map that turns your master plan into your best salesperson.",
};

export default function MpcgLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`mpcg ${grotesk.variable} ${mono.variable}`}>
      {children}
    </div>
  );
}
