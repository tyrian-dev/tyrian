"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount, useConfig } from "wagmi";
import { useTyrianSession } from "@/providers/TyrianSessionProvider";
import {
  WalletOnboardingContext,
  type WalletOnboardingStep,
} from "@/providers/WalletOnboardingContext";
import { WalletOnboardingModal } from "@/components/wallet/WalletOnboardingModal";
import {
  TARGET_CHAIN,
  TARGET_CHAIN_ID,
  isTargetChain,
} from "@/lib/wallet/targetChain";
import {
  getConnectorProvider,
  isPhantomConnector,
  readProviderChainId,
  syncConnectionChain,
  type WalletProvider,
} from "@/lib/wallet/providerChain";

const TOS_ENABLED = process.env.NEXT_PUBLIC_ONBOARDING_TOS === "true";
const SWITCH_TIMEOUT_MS = 20_000;
const ADD_CHAIN_TIMEOUT_MS = 60_000;
const SWITCH_SETTLE_MS = 400;
const SWITCH_TIMEOUT_MESSAGE = "NETWORK_SWITCH_TIMEOUT";
const PHANTOM_NETWORK_MESSAGE = "PHANTOM_NETWORK_NOT_ACTIVE";
const CHAIN_NOT_CHANGED_MESSAGE = "NETWORK_CHAIN_NOT_CHANGED";

class ChainNotChangedError extends Error {
  readonly actualChainId: number;

  constructor(actualChainId: number) {
    super(`${CHAIN_NOT_CHANGED_MESSAGE}:${actualChainId}`);
    this.name = "ChainNotChangedError";
    this.actualChainId = actualChainId;
  }
}

function withTimeout<T>(promise: Promise<T>, ms = SWITCH_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(SWITCH_TIMEOUT_MESSAGE)),
      ms,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function readErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as {
    code?: unknown;
    cause?: { code?: unknown };
    data?: { originalError?: { code?: unknown } };
  };
  const codes = [
    candidate.code,
    candidate.cause?.code,
    candidate.data?.originalError?.code,
  ];
  for (const code of codes) {
    if (typeof code === "number") return code;
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function toChainHex(chainId: number): `0x${string}` {
  return `0x${chainId.toString(16)}`;
}

function addChainParameters() {
  return {
    chainId: toChainHex(TARGET_CHAIN_ID),
    chainName: TARGET_CHAIN.name,
    nativeCurrency: TARGET_CHAIN.nativeCurrency,
    rpcUrls: [...(TARGET_CHAIN.rpcUrls.default?.http ?? [])],
    blockExplorerUrls: TARGET_CHAIN.blockExplorers?.default.url
      ? [TARGET_CHAIN.blockExplorers.default.url]
      : undefined,
  };
}

async function verifyProviderChain(provider: WalletProvider): Promise<number> {
  // Give the wallet a moment to update `eth_chainId` and emit `chainChanged`.
  // Some wallets resolve the switch request before their RPC state settles.
  await delay(SWITCH_SETTLE_MS);
  return readProviderChainId(provider);
}

async function switchProviderToTarget(
  provider: WalletProvider,
  phantom: boolean,
): Promise<void> {
  const targetHex = toChainHex(TARGET_CHAIN_ID);
  const initialChainId = await readProviderChainId(provider);
  if (initialChainId === TARGET_CHAIN_ID) return;

  let switchError: unknown;
  try {
    await withTimeout(
      provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: targetHex }],
      }),
      SWITCH_TIMEOUT_MS,
    );
  } catch (error) {
    switchError = error;
  }

  let actualChainId = await verifyProviderChain(provider);
  if (actualChainId === TARGET_CHAIN_ID) return;

  if (phantom) {
    if (readErrorCode(switchError) === 4001) throw switchError;
    throw new Error(PHANTOM_NETWORK_MESSAGE);
  }

  if (readErrorCode(switchError) === 4001) throw switchError;
  if (
    switchError instanceof Error &&
    switchError.message === SWITCH_TIMEOUT_MESSAGE
  ) {
    throw switchError;
  }

  // Some wallets silently return `null` from `wallet_switchEthereumChain`
  // without changing networks. Try adding the chain explicitly, then switch
  // again. Already-added/unsupported add errors are tolerated because the final
  // `eth_chainId` check below is the source of truth.
  try {
    await withTimeout(
      provider.request({
        method: "wallet_addEthereumChain",
        params: [addChainParameters()],
      }),
      ADD_CHAIN_TIMEOUT_MS,
    );
  } catch (error) {
    if (readErrorCode(error) === 4001) throw error;
    if (error instanceof Error && error.message === SWITCH_TIMEOUT_MESSAGE) {
      throw error;
    }
  }

  try {
    await withTimeout(
      provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: targetHex }],
      }),
      SWITCH_TIMEOUT_MS,
    );
  } catch (error) {
    if (readErrorCode(error) === 4001) throw error;
    if (error instanceof Error && error.message === SWITCH_TIMEOUT_MESSAGE) {
      throw error;
    }
  }

  actualChainId = await verifyProviderChain(provider);
  if (actualChainId !== TARGET_CHAIN_ID) {
    throw new ChainNotChangedError(actualChainId);
  }
}

function switchErrorMessage(error: unknown, phantom: boolean): string {
  if (
    error instanceof Error &&
    error.message === PHANTOM_NETWORK_MESSAGE
  ) {
    return "Phantom is not on Robinhood Chain Testnet yet. In Phantom, open Settings → Active Networks, enable Robinhood Chain, then try again.";
  }

  if (error instanceof ChainNotChangedError) {
    return `Your wallet is still on another network (chain ${error.actualChainId}). Switch to ${TARGET_CHAIN.name} manually, then try again.`;
  }

  if (error instanceof Error && error.message === SWITCH_TIMEOUT_MESSAGE) {
    return phantom
      ? "Phantom did not respond. Make sure Robinhood Chain is enabled in Settings → Active Networks, then try again."
      : `Your wallet did not respond. Switch to ${TARGET_CHAIN.name} manually in your wallet, or use a different wallet.`;
  }

  const code = readErrorCode(error);
  if (code === 4001) {
    return "Network switch was cancelled in your wallet. Try again or use a different wallet.";
  }
  if (code === 4902) {
    return phantom
      ? "Phantom does not have Robinhood Chain enabled. Open Settings → Active Networks, enable Robinhood Chain, then try again."
      : `Add ${TARGET_CHAIN.name} to your wallet, then try again.`;
  }
  if (error instanceof Error && error.message) {
    return error.message.length > 220
      ? `${error.message.slice(0, 217)}...`
      : error.message;
  }
  return "Could not switch network. Try again in your wallet.";
}

export function WalletOnboardingProvider({ children }: { children: ReactNode }) {
  const { address, isConnected, chainId, connector } = useAccount();
  const config = useConfig();
  const { authenticated, signOut } = useTyrianSession();
  const { openConnectModal } = useConnectModal();

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<WalletOnboardingStep>("network");
  const [pendingOpen, setPendingOpen] = useState(false);
  const [reopenPicker, setReopenPicker] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);

  const resolveStep = useCallback((): WalletOnboardingStep => {
    if (!isTargetChain(chainId)) return "network";
    if (TOS_ENABLED && !termsAccepted) return "terms";
    if (!authenticated) return "signin";
    return "done";
  }, [authenticated, chainId, termsAccepted]);

  // A user can start the flow from a CTA before RainbowKit has connected a
  // wallet. Once the connector reports a wallet, continue in the Tyrian modal.
  useEffect(() => {
    if (!pendingOpen || !isConnected) return;
    setPendingOpen(false);
    setOpen(true);
    setStep(resolveStep());
  }, [isConnected, pendingOpen, resolveStep]);

  // Keep the visible step in sync with wallet/network/session changes. This is
  // also the "resume" path when a user closes and reopens the flow.
  useEffect(() => {
    if (!open) return;
    if (!isConnected) {
      setOpen(false);
      setPendingOpen(false);
      return;
    }
    setStep(resolveStep());
  }, [isConnected, open, resolveStep]);

  // RainbowKit only exposes `openConnectModal` once it has registered the
  // disconnect. Waiting for that state avoids a silent no-op after switching
  // wallets from the Tyrian modal.
  useEffect(() => {
    if (!reopenPicker || isConnected || !openConnectModal) return;
    setReopenPicker(false);
    openConnectModal();
  }, [isConnected, openConnectModal, reopenPicker]);

  const openWalletOnboarding = useCallback(() => {
    setError("");

    if (!isConnected) {
      setPendingOpen(true);
      openConnectModal?.();
      return;
    }

    setPendingOpen(false);
    setOpen(true);
    setStep(resolveStep());
  }, [isConnected, openConnectModal, resolveStep]);

  const resumeOnboarding = useCallback(() => {
    openWalletOnboarding();
  }, [openWalletOnboarding]);

  const closeWalletOnboarding = useCallback(() => {
    setOpen(false);
    setPendingOpen(false);
    setError("");
  }, []);

  const switchWallet = useCallback(async () => {
    // Drop the Tyrian session before disconnecting so the next wallet never
    // inherits the previous address' cookie. `signOut` also disconnects the
    // active connector, which is what allows RainbowKit to open again.
    closeWalletOnboarding();
    setTermsAccepted(false);
    setError("");
    setReopenPicker(true);
    try {
      await signOut();
    } catch {}
    setPendingOpen(true);
  }, [closeWalletOnboarding, signOut]);

  const switchToTargetChain = useCallback(async () => {
    setSwitching(true);
    setError("");
    try {
      if (!connector) {
        throw new Error("Reconnect your wallet, then try again.");
      }

      const provider = await getConnectorProvider(connector);
      if (!provider) {
        throw new Error("Could not access the wallet provider. Reconnect and try again.");
      }

      await switchProviderToTarget(provider, isPhantomConnector(connector));

      // The switch is only complete after the provider itself reports the
      // target chain. Mirror that verified chain into wagmi before advancing.
      syncConnectionChain(config, connector, TARGET_CHAIN_ID);
    } catch (err) {
      setError(switchErrorMessage(err, isPhantomConnector(connector)));
    } finally {
      setSwitching(false);
    }
  }, [config, connector]);

  // Load persistent ToS acknowledgement from localStorage or backend status
  useEffect(() => {
    if (!address || typeof window === "undefined") {
      setTermsAccepted(false);
      return;
    }
    const key = `tyr_tos_${address.toLowerCase()}`;
    if (localStorage.getItem(key) === "true") {
      setTermsAccepted(true);
      return;
    }

    if (authenticated) {
      fetch("/api/auth/terms/status")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.accepted) {
            localStorage.setItem(key, "true");
            setTermsAccepted(true);
          }
        })
        .catch(() => {});
    }
  }, [address, authenticated]);

  const acceptTerms = useCallback(async () => {
    setTermsAccepted(true);
    if (!address || typeof window === "undefined") return;

    const key = `tyr_tos_${address.toLowerCase()}`;
    localStorage.setItem(key, "true");

    try {
      await fetch("/api/auth/terms/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      // Non-fatal if offline/local
    }
  }, [address]);

  const value = useMemo(
    () => ({
      open,
      step,
      error,
      switching,
      targetChain: TARGET_CHAIN,
      currentChainId: chainId ?? null,
      termsEnabled: TOS_ENABLED,
      termsAccepted,
      openWalletOnboarding,
      closeWalletOnboarding,
      resumeOnboarding,
      switchToTargetChain,
      switchWallet,
      acceptTerms,
    }),
    [
      acceptTerms,
      chainId,
      closeWalletOnboarding,
      error,
      open,
      openWalletOnboarding,
      resumeOnboarding,
      step,
      switchToTargetChain,
      switchWallet,
      switching,
      termsAccepted,
    ],
  );

  return (
    <WalletOnboardingContext.Provider value={value}>
      {children}
      <WalletOnboardingModal />
    </WalletOnboardingContext.Provider>
  );
}
