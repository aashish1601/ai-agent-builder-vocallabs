import type { Metadata } from "next";
import { Inter, Manrope } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-body" });
const manrope = Manrope({ subsets: ["latin"], variable: "--font-display" });

export const metadata: Metadata = {
  title: "AgentForge — AI workflow operations",
  description: "Secure, multi-tenant AI agent workflow automation built on Nhost and Hasura.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${manrope.variable}`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
