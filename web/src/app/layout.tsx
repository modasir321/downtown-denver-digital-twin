import type { Metadata } from "next";
import { Source_Serif_4, DM_Sans } from "next/font/google";
import "./globals.css";

const display = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-display",
});

const sans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "Downtown Denver Digital Twin",
  description: "Downtown Denver 3D digital twin",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${display.variable} ${sans.variable} antialiased`}
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}
