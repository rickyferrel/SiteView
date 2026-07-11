import type { Metadata } from "next";
import { Jost, Cormorant_Garamond, Archivo } from "next/font/google";
import "./mpcg.css";

// The landing page's own type system (distinct from the portal chrome):
// Jost carries Noir + Ivory, Cormorant Garamond is Ivory's display serif,
// and Archivo (up to Black) powers the Signal variant's poster headlines.
const jost = Jost({
  variable: "--mpcg-jost",
  subsets: ["latin"],
  weight: ["200", "300", "400", "500", "600"],
  style: ["normal", "italic"],
});

const cormorant = Cormorant_Garamond({
  variable: "--mpcg-serif",
  subsets: ["latin"],
  weight: ["300", "400"],
  style: ["normal", "italic"],
});

const archivo = Archivo({
  variable: "--mpcg-arch",
  subsets: ["latin"],
  weight: ["500", "600", "700", "800", "900"],
});

export const metadata: Metadata = {
  title: "MPCG — From dirt to sold out",
  description:
    "MPCG builds the brand, the website, and the campaigns — anchored by SiteView, an interactive 3D map that turns your master plan into your best salesperson.",
};

export default function MpcgLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`mpcg ${jost.variable} ${cormorant.variable} ${archivo.variable}`}>
      {children}
    </div>
  );
}
