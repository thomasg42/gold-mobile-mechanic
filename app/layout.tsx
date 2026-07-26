import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const description =
  "Clock mobile mechanic jobs, capture receipts, record recommendations, and prepare complete customer invoices.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ||
    requestHeaders.get("host") ||
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ||
    (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const socialImage = new URL("/og.png", origin).toString();

  return {
    title: "Gold Mobile Mechanic — Job Clock & Invoices",
    description,
    applicationName: "Gold Mobile Mechanic",
    manifest: "/manifest.webmanifest",
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: "Gold Mechanic",
    },
    formatDetection: {
      telephone: false,
    },
    openGraph: {
      type: "website",
      siteName: "Gold Mobile Mechanic",
      title: "Gold Mobile Mechanic",
      description,
      images: [
        {
          url: socialImage,
          width: 1536,
          height: 1024,
          alt: "Gold Mobile Mechanic job timer, receipt capture, and invoice workflow",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Gold Mobile Mechanic",
      description,
      images: [socialImage],
    },
  };
}

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#090b0d",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
