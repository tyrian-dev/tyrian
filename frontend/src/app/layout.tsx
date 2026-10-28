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
    icon: "/favicon.svg",
    apple: "/apple-touch-icon.png",
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
              <rect width="64" height="64" rx="14" fill="#66023C" />
              <path
                d="M32.00 28.80 L32.25 28.69 L32.51 28.60 L32.79 28.54 L33.08 28.49 L33.38 28.47 L33.69 28.48 L34.01 28.51 L34.33 28.58 L34.65 28.67 L34.97 28.79 L35.29 28.94 L35.60 29.12 L35.90 29.33 L36.19 29.57 L36.47 29.83 L36.72 30.13 L36.96 30.45 L37.18 30.80 L37.37 31.17 L37.53 31.56 L37.67 31.98 L37.77 32.41 L37.84 32.85 L37.88 33.31 L37.87 33.78 L37.83 34.26 L37.76 34.74 L37.64 35.22 L37.48 35.69 L37.28 36.16 L37.04 36.62 L36.76 37.07 L36.45 37.51 L36.09 37.92 L35.70 38.31 L35.27 38.67 L34.81 39.01 L34.31 39.31 L33.79 39.57 L33.24 39.80 L32.66 39.99 L32.06 40.13 L31.45 40.23 L30.82 40.29 L30.18 40.29 L29.53 40.24 L28.88 40.15 L28.24 40.00 L27.59 39.80 L26.96 39.55 L26.34 39.24 L25.73 38.89 L25.15 38.48 L24.60 38.03 L24.07 37.52 L23.58 36.98 L23.13 36.39 L22.72 35.76 L22.35 35.09 L22.03 34.39 L21.77 33.66 L21.55 32.90 L21.40 32.12 L21.30 31.33 L21.26 30.52 L21.29 29.69 L21.38 28.87 L21.53 28.04 L21.75 27.23 L22.03 26.42 L22.38 25.63 L22.79 24.85 L23.26 24.11 L23.79 23.39 L24.38 22.71 L25.03 22.08 L25.72 21.48 L26.47 20.94 L27.27 20.45 L28.11 20.02 L28.98 19.65 L29.89 19.34 L30.83 19.10 L31.79 18.93 L32.78 18.84 L33.77 18.81 L34.77 18.87 L35.78 19.00 L36.78 19.21 L37.77 19.49 L38.74 19.85 L39.69 20.29 L40.61 20.80 L41.50 21.39 L42.35 22.05 L43.16 22.77 L43.91 23.56 L44.61 24.41 L45.24 25.32 L45.81 26.28 L46.31 27.29 L46.74 28.34 L47.08 29.43 L47.35 30.55 L47.53 31.69 L47.63 32.86 L47.64 34.04 L47.56 35.22 L47.39 36.41 L47.13 37.58 L46.78 38.74 L46.34 39.88 L45.81 40.99 L45.19 42.07 L44.49 43.10 L43.71 44.09 L42.85 45.02 L41.92 45.88 L40.92 46.69 L39.85 47.41 L38.73 48.07 L37.55 48.63 L36.32 49.12 L35.06 49.51 L33.75 49.80 L32.42 50.00 L31.08 50.10 L29.71 50.10 L28.35 49.99 L26.99 49.78 L25.63 49.47 L24.30 49.05 L22.99 48.53 L21.72 47.92 L20.49 47.20 L19.32 46.39 L18.19 45.48 L17.14 44.49 L16.15 43.42 L15.25 42.27 L14.42 41.04 L13.69 39.75 L13.05 38.40 L12.51 37.00 L12.08 35.56 L11.75 34.07 L11.54 32.56 L11.43 31.03 L11.45 29.49 L11.58 27.94 L11.82 26.39 L12.19 24.87 L12.66 23.36 L13.26 21.89 L13.97 20.46 L14.78 19.07 L15.71 17.75 L16.73 16.49 L17.85 15.30 L19.07 14.20"
                fill="none"
                stroke="#C9A24A"
                strokeWidth="6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
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
