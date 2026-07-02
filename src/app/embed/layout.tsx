import "./embed.css";

export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return <div className="sc-embed">{children}</div>;
}
