import PortalNav, { PortalFooter } from "@/components/PortalNav";

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <PortalNav />
      <main className="mx-auto w-full max-w-[1180px] flex-1 px-6 py-9">{children}</main>
      <PortalFooter />
    </div>
  );
}
