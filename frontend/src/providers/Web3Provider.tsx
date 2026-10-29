"use client";

import React, { useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider, darkTheme, lightTheme } from "@rainbow-me/rainbowkit";
import { config } from "@/config/wagmi";
import { TARGET_CHAIN } from "@/lib/wallet/targetChain";
import { TyrianSessionProvider } from "@/providers/TyrianSessionProvider";
import { WalletOnboardingProvider } from "@/providers/WalletOnboardingProvider";
import "@rainbow-me/rainbowkit/styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 1000 * 60,
    },
  },
});

function useDocumentTheme(): "dark" | "light" {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const readTheme = () => {
      setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
    };
    readTheme();

    const observer = new MutationObserver(readTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return theme;
}

export function Web3Provider({ children }: { children: React.ReactNode }) {
  const theme = useDocumentTheme();

  // With `ssr: true` wagmi hydrates connectors before some extensions finish
  // announcing. Re-request EIP-6963 once the app has mounted so MetaMask and
  // Phantom are registered even when they announce late.
  useEffect(() => {
    config._internal.mipd?.reset();
  }, []);

  const rainbowTheme = useMemo(
    () =>
      (theme === "light" ? lightTheme : darkTheme)({
        accentColor: "#66023C",
        accentColorForeground: "#F5EFE6",
        borderRadius: "large",
        fontStack: "system",
        overlayBlur: "small",
      }),
    [theme],
  );

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={rainbowTheme} initialChain={TARGET_CHAIN}>
          <TyrianSessionProvider>
            <WalletOnboardingProvider>{children}</WalletOnboardingProvider>
          </TyrianSessionProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
