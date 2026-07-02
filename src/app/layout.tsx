import type { Metadata } from "next";
import { Archivo, Inter, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

// Display: Archivo — engineered, instrument-like grotesk for the wordmark,
// headings, and big readouts. Used with restraint at tight tracking.
const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
});

// UI / body.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

// Data: parcel ids, prices, coordinates, metrics, cartographic labels.
const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Map Portal — operator console",
  description: "Edit, preview, and publish 3D parcel maps for every development you run.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${inter.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
