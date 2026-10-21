import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Maestri Web - Multi-Agent Dev Orchestrator",
  description: "Web orchestrator for distributed teams using AI agents and Git Worktrees",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}
