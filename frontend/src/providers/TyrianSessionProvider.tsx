"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAccount, useConfig, useDisconnect, useSignMessage } from "wagmi";
import { createSiweMessage } from "viem/siwe";
import { TARGET_CHAIN, isTargetChain } from "@/lib/wallet/targetChain";
import {
  getConnectorProvider,
  readProviderChainId,
  syncConnectionChain,
} from "@/lib/wallet/providerChain";

interface TyrianSessionContextValue {
  authenticated: boolean;
  loading: boolean;
  signingIn: boolean;
  error: string;
  sessionChainId: number | null;
  signIn: () => Promise<boolean>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const TyrianSessionContext = createContext<TyrianSessionContextValue | null>(null);

async function readApiError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    const message = body?.error || body?.message || body?.details;
    if (typeof message === "string" && message.trim()) return message;
  } catch {}
  return `Request failed (HTTP ${response.status}).`;
}

export function TyrianSessionProvider({ children }: { children: ReactNode }) {
  // useChainId() reports the config's selected chain, which stays on the target
  // even when the connected wallet is on an unsupported network. The account
  // chain is the actual wallet chain and must drive SIWE + session binding.
  const { address, chainId, connector } = useAccount();
  const config = useConfig();
  const { signMessageAsync } = useSignMessage();
  const { disconnectAsync } = useDisconnect();

  const [sessionAddress, setSessionAddress] = useState<string | null>(null);
  const [sessionChainId, setSessionChainId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/auth/me", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) {
        setSessionAddress(null);
        setSessionChainId(null);
        return;
      }

      const data = await response.json();
      const nextAddress =
        data?.authenticated && typeof data.address === "string"
          ? data.address.toLowerCase()
          : null;
      setSessionAddress(nextAddress);
      setSessionChainId(
        nextAddress && typeof data?.chainId === "number" ? data.chainId : null,
      );
      if (nextAddress) setError("");
    } catch {
      setSessionAddress(null);
      setSessionChainId(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    // Keep the server session while the wallet is disconnected. `authenticated`
    // already requires a connected address; clearing it here would race the
    // initial `/me` refresh and force a needless re-sign-in after reconnect.
    if (!address) return;

    if (
      sessionAddress &&
      sessionAddress.toLowerCase() !== address.toLowerCase()
    ) {
      setSessionAddress(null);
      setSessionChainId(null);
      setError("Wallet changed. Sign in again to manage keys.");
      void fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      }).catch(() => {});
    }
  }, [address, sessionAddress]);

  useEffect(() => {
    if (!address || !sessionAddress) return;
    if (address.toLowerCase() !== sessionAddress.toLowerCase()) return;

    if (!isTargetChain(chainId)) {
      setError(`Switch to ${TARGET_CHAIN.name} before signing in.`);
      return;
    }

    if (sessionChainId !== null && chainId !== sessionChainId) {
      setError("Network changed. Sign in again on this network.");
      return;
    }

    setError((current) =>
      current === "Network changed. Sign in again on this network." ||
      current.startsWith("Switch to ")
        ? ""
        : current,
    );
  }, [address, chainId, sessionAddress, sessionChainId]);

  const signIn = useCallback(async (): Promise<boolean> => {
    if (!address) {
      setError("Connect a wallet first.");
      return false;
    }
    if (!connector) {
      setError("Reconnect your wallet, then try again.");
      return false;
    }
    if (signingIn) return false;

    setSigningIn(true);
    setError("");

    try {
      const provider = await getConnectorProvider(connector);
      if (!provider) {
        throw new Error("Could not access the wallet provider. Reconnect and try again.");
      }

      const actualChainId = await readProviderChainId(provider);
      if (!isTargetChain(actualChainId)) {
        setError(`Switch to ${TARGET_CHAIN.name} before signing in.`);
        return false;
      }

      if (actualChainId !== chainId) {
        syncConnectionChain(config, connector, actualChainId);
      }

      const nonceResponse = await fetch("/api/auth/nonce", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!nonceResponse.ok) {
        throw new Error(await readApiError(nonceResponse));
      }

      const { nonce } = await nonceResponse.json();
      if (typeof nonce !== "string" || !nonce) {
        throw new Error("The server did not return a sign-in nonce.");
      }

      const message = createSiweMessage({
        address,
        chainId: actualChainId,
        domain: window.location.host,
        nonce,
        uri: `${window.location.origin}/`,
        version: "1",
        statement: "Sign in to Tyrian to manage API keys and quota.",
        issuedAt: new Date(),
        expirationTime: new Date(Date.now() + 5 * 60 * 1000),
      });

      const signature = await signMessageAsync({ message });

      const verifyResponse = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ message, signature, address }),
      });

      if (!verifyResponse.ok) {
        throw new Error(await readApiError(verifyResponse));
      }

      const data = await verifyResponse.json();
      setSessionAddress(
        typeof data?.address === "string" ? data.address.toLowerCase() : address.toLowerCase(),
      );
      setSessionChainId(actualChainId);
      setError("");
      return true;
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : "Sign-in failed. Please try again.";
      setError(message);
      return false;
    } finally {
      setSigningIn(false);
    }
  }, [address, chainId, config, connector, signMessageAsync, signingIn]);

  const signOut = useCallback(async () => {
    setSessionAddress(null);
    setSessionChainId(null);
    setError("");
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
    } catch {}
    try {
      await disconnectAsync();
    } catch {}
  }, [disconnectAsync]);

  const authenticated =
    Boolean(address && sessionAddress) &&
    address!.toLowerCase() === sessionAddress!.toLowerCase() &&
    isTargetChain(chainId) &&
    (sessionChainId === null || chainId === sessionChainId);

  const value = useMemo<TyrianSessionContextValue>(
    () => ({
      authenticated,
      loading,
      signingIn,
      error,
      sessionChainId,
      signIn,
      signOut,
      refresh,
    }),
    [
      authenticated,
      loading,
      signingIn,
      error,
      sessionChainId,
      signIn,
      signOut,
      refresh,
    ],
  );

  return (
    <TyrianSessionContext.Provider value={value}>
      {children}
    </TyrianSessionContext.Provider>
  );
}

export function useTyrianSession(): TyrianSessionContextValue {
  const value = useContext(TyrianSessionContext);
  if (!value) {
    throw new Error("useTyrianSession must be used inside TyrianSessionProvider.");
  }
  return value;
}
