import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import { Web3Provider } from "@/providers/Web3Provider";
import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { SmoothScroll } from "@/components/effects/SmoothScroll";
import { Grain } from "@/components/effects/Grain";
import { Cursor } from "@/components/effects/Cursor";
import { PageMotion } from "@/components/effects/PageMotion";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://tyrian.app"),
  title: "Tyrian · Once only for emperors",
  description:
    "Tyrian ($TYR): stake assets, use every AI model. Inference is funded by staked-asset yield and $TYR creator fees on Robinhood Chain.",
  openGraph: {
    title: "Tyrian · Once only for emperors",
    description:
      "Stake assets, use every AI model. Inference is paid by staked-asset yield and $TYR creator fees on Robinhood Chain.",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Tyrian" }],
  },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/logo.png" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
      { url: "/logo.png" },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <Script
          id="tyr-theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('tyr-theme');if(t!=='light'&&t!=='dark')t='dark';document.documentElement.setAttribute('data-theme',t);document.documentElement.style.colorScheme=t;}catch(e){}})();",
          }}
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600&family=Inter+Tight:wght@500;600;700&family=Inter:wght@400;500&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Grain />
        <Cursor />
        <SmoothScroll />
        <PageMotion />

        {/* Global SVG Sprite Defs for #mark and #murex */}
        <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
          <defs>
            <symbol id="mark" viewBox="0 0 64 64">
              <clipPath id="mark-clip">
                <rect width="64" height="64" rx="14" />
              </clipPath>
              <g clipPath="url(#mark-clip)">
                <image href="/logo.png" width="64" height="64" preserveAspectRatio="xMidYMid meet" />
              </g>
            </symbol>
            <symbol id="murex" viewBox="-100 -100 200 200">
              <path
                fill="none"
                stroke="currentColor"
                strokeWidth="1.1"
                strokeLinecap="round"
                d="M0,0 C2,-3 6,-2 6,2 C6,8 -2,11 -8,8 C-15,4 -14,-8 -6,-13 C4,-19 18,-14 21,-2 C25,13 12,27 -5,28 C-25,29 -38,12 -35,-8 C-31,-31 -8,-44 15,-40 C42,-35 56,-10 51,16 C45,46 15,63 -16,59 C-50,54 -70,24 -66,-11 C-61,-50 -24,-75 17,-71 C60,-66 89,-28 84,17"
              />
            </symbol>
          </defs>
        </svg>

        <Web3Provider>
          <Navbar />
          <div id="main" className="site-main">
            {children}
          </div>
          <Footer />
        </Web3Provider>

        <div className="toast" id="toast" role="status" aria-live="polite">
          <i />
          <span id="toastText">Waiting for signature…</span>
        </div>
      </body>
    </html>
  );
}
