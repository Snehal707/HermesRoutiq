import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HermesRoutiq — Operations Dashboard",
  description:
    "Autonomous delivery operations that think in routes, risk, and revenue.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#0a0e14] text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}
