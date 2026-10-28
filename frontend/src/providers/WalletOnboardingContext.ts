import { createContext, useContext } from "react";
import type { Chain } from "viem";

export type WalletOnboardingStep = "network" | "terms" | "signin" | "done";

export interface WalletOnboardingContextValue {
  open: boolean;
  step: WalletOnboardingStep;
  error: string;
  switching: boolean;
  targetChain: Chain;
  currentChainId: number | null;
  termsEnabled: boolean;
  termsAccepted: boolean;
  openWalletOnboarding: () => void;
  closeWalletOnboarding: () => void;
  resumeOnboarding: () => void;
  switchToTargetChain: () => Promise<void>;
  switchWallet: () => Promise<void>;
  acceptTerms: () => void;
}

export const WalletOnboardingContext =
  createContext<WalletOnboardingContextValue | null>(null);

export function useWalletOnboarding(): WalletOnboardingContextValue {
  const value = useContext(WalletOnboardingContext);
  if (!value) {
    throw new Error(
      "useWalletOnboarding must be used inside WalletOnboardingProvider.",
    );
  }
  return value;
}
