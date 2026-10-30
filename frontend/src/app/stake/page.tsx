"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useAccount, useChainId } from "wagmi";
import { parseUnits, formatUnits, type Address } from "viem";
import { useWalletOnboarding } from "@/hooks/useWalletOnboarding";
import { useStakeContract } from "@/hooks/useStakeContract";
import {
  getDataSourceMode,
  getStakeDataSource,
  isLiveDataMode,
} from "@/lib/data/source";
import {
  activeNetwork,
  isAddress,
} from "@shared/contracts/addresses";
import { isTargetChain } from "@/lib/wallet/targetChain";
import { formatWalletError } from "@/lib/wallet/errors";
import { TokenLogo } from "@/components/ui/TokenLogo";
import type { AssetDef, UserPosition } from "@/lib/data/types";

interface LivePositionItem {
  asset: string;
  assetAddress: string;
  activeShares: string;
  pendingShares: string;
  cooldownShares: string;
  estimatedUsdValue: number;
}

interface CooldownItem {
  id: string;
  asset: string;
  assetAddress: string;
  requestId: string;
  shares: string;
  unlockAt: string;
  claimed: boolean;
  txHash: string;
}

export default function StakePage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { openWalletOnboarding } = useWalletOnboarding();
  const isCorrectChain = isConnected ? isTargetChain(chainId) : true;

  const {
    stakeManagerAddress,
    state: txState,
    resetState: resetTxState,
    getBalance,
    getAllowance,
    approveToken,
    stakeTokens,
    requestUnstakeTokens,
    withdrawTokens,
    mintMockTokens,
    getExplorerTxUrl,
  } = useStakeContract();

  const isLive = isLiveDataMode();
  const stakeDataSource = getStakeDataSource();
  const assets = useMemo(() => stakeDataSource.getAssets(), [stakeDataSource]);

  const [filter, setFilter] = useState<"all" | "base" | "stock" | "boost">("all");
  const [inputs, setInputs] = useState<Record<string, string>>({});

  // Live on-chain balances and allowances (token symbol -> bigint)
  const [onChainBalances, setOnChainBalances] = useState<Record<string, bigint>>({});
  const [onChainAllowances, setOnChainAllowances] = useState<Record<string, bigint>>({});
  const [loadingBalances, setLoadingBalances] = useState(false);

  // Staked positions and cooldowns from backend/indexer
  const [livePositions, setLivePositions] = useState<LivePositionItem[]>([]);
  const [liveCooldowns, setLiveCooldowns] = useState<CooldownItem[]>([]);
  const [positionsLoaded, setPositionsLoaded] = useState(false);


  // Modal dialog states
  const [modalAsset, setModalAsset] = useState<AssetDef | null>(null);
  const [modalAmount, setModalAmount] = useState<string>("");
  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [modalError, setModalError] = useState<string>("");

  // Unstake Modal state
  const [unstakeModalOpen, setUnstakeModalOpen] = useState(false);
  const [unstakeAsset, setUnstakeAsset] = useState<string>("");
  const [unstakeAssetAddress, setUnstakeAssetAddress] = useState<Address | null>(null);
  const [unstakeMaxAmount, setUnstakeMaxAmount] = useState<number>(0);
  const [unstakeAmount, setUnstakeAmount] = useState<string>("");
  const [unstakeError, setUnstakeError] = useState<string>("");

  // Countdown timer to 00:00 UTC epoch reset
  const [nextEpochCountdown, setNextEpochCountdown] = useState<string>("00:00:00");

  useEffect(() => {
    const updateCountdown = () => {
      const now = new Date();
      const nextUtc = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0),
      );
      const diff = Math.max(0, Math.floor((nextUtc.getTime() - now.getTime()) / 1000));
      const h = Math.floor(diff / 3600);
      const m = Math.floor((diff % 3600) / 60);
      const s = diff % 60;
      setNextEpochCountdown(
        `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`,
      );
    };
    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, []);

  // Fetch live positions from backend /v1/quota
  const refreshPositions = useCallback(async () => {
    if (!address) {
      setLivePositions((prev) => (prev.length === 0 ? prev : []));
      setLiveCooldowns((prev) => (prev.length === 0 ? prev : []));
      setPositionsLoaded(false);
      return;
    }

    try {
      const res = await fetch(`/v1/quota?address=${encodeURIComponent(address)}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const d = await res.json();
        if (Array.isArray(d.positions)) setLivePositions(d.positions);
        if (Array.isArray(d.cooldowns)) setLiveCooldowns(d.cooldowns);
        setPositionsLoaded(true);
      }
    } catch (err) {
      console.warn("[StakePage] Failed to fetch live quota/positions:", err);
    }
  }, [address]);

  // Fetch live on-chain balances and allowances for assets
  const refreshOnChainBalances = useCallback(async () => {
    if (!address || !isConnected) {
      setOnChainBalances((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      setOnChainAllowances((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }

    setLoadingBalances(true);
    const newBalances: Record<string, bigint> = {};
    const newAllowances: Record<string, bigint> = {};

    try {
      await Promise.all(
        assets.map(async (asset) => {
          let tokenAddr: Address | undefined;
          if (asset.symbol === "USDG") tokenAddr = activeNetwork.tokens.USDG?.address as Address;
          else if (asset.symbol === "TYRN" || asset.symbol === "TYR") tokenAddr = activeNetwork.tokens.TYRN?.address as Address;
          else if (activeNetwork.stocks?.[asset.symbol]?.address) {
            tokenAddr = activeNetwork.stocks[asset.symbol].address as Address;
          }

          if (tokenAddr && isAddress(tokenAddr)) {
            const [bal, allow] = await Promise.all([
              getBalance(tokenAddr),
              getAllowance(tokenAddr),
            ]);
            newBalances[asset.symbol] = bal;
            newAllowances[asset.symbol] = allow;
          }
        }),
      );

      setOnChainBalances(newBalances);
      setOnChainAllowances(newAllowances);
    } catch (err) {
      console.warn("[StakePage] Error reading on-chain balances:", err);
    } finally {
      setLoadingBalances(false);
    }
  }, [address, isConnected, assets, getBalance, getAllowance]);

  // Refresh balances and positions when wallet changes
  useEffect(() => {
    refreshPositions();
    refreshOnChainBalances();
  }, [address, isConnected, refreshPositions, refreshOnChainBalances]);

  // Resolve token decimals based on active network manifest
  const getAssetDecimals = useCallback((symbol: string): number => {
    if (symbol === "USDG") return activeNetwork.tokens.USDG?.decimals ?? 6;
    if (symbol === "TYRN" || symbol === "TYR") return activeNetwork.tokens.TYRN?.decimals ?? 18;
    if (symbol === "WETH") return activeNetwork.tokens.WETH?.decimals ?? 18;
    const stock = activeNetwork.stocks?.[symbol];
    if (stock?.decimals !== undefined) return stock.decimals;
    return 18;
  }, []);

  const safeParseUnits = useCallback((val: string, decimals: number): bigint => {
    try {
      const trimmed = val.trim();
      if (!trimmed || Number.isNaN(Number(trimmed))) return 0n;
      const parts = trimmed.split(".");
      let normalized = parts[0] || "0";
      if (parts.length > 1) {
        normalized += `.${parts[1].slice(0, decimals)}`;
      }
      return parseUnits(normalized, decimals);
    } catch {
      return 0n;
    }
  }, []);

  // Read available balance for an asset (uses on-chain if connected, 0 otherwise)
  const getAvailableBalance = (symbol: string): number => {
    if (isConnected && onChainBalances[symbol] !== undefined) {
      try {
        const decimals = getAssetDecimals(symbol);
        return Number(formatUnits(onChainBalances[symbol], decimals));
      } catch {
        return 0;
      }
    }
    return 0;
  };

  const getAssetAllowance = (symbol: string): bigint => {
    return onChainAllowances[symbol] ?? 0n;
  };

  const resolveAssetAddress = (symbol: string): Address | null => {
    if (symbol === "USDG") return (activeNetwork.tokens.USDG?.address as Address) || null;
    if (symbol === "TYRN" || symbol === "TYR") return (activeNetwork.tokens.TYRN?.address as Address) || null;
    const stock = activeNetwork.stocks?.[symbol];
    if (stock?.address && isAddress(stock.address)) return stock.address as Address;
    return null;
  };

  const fmtAmount = (symbol: string, amount: number) => {
    if (symbol === "USDG") {
      return amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    if (symbol === "TYRN" || symbol === "TYR") {
      return amount.toLocaleString("en-US", { maximumFractionDigits: 0 });
    }
    return amount.toLocaleString("en-US", { maximumFractionDigits: 4 });
  };

  // Filter assets
  const filteredAssets = assets.filter((a) => {
    if (filter === "all") return true;
    return a.type === filter;
  });

  // Calculate position totals
  let baseStakeTotal = 0;
  let tyrStakeCount = 0;
  let tyrStakeUsd = 0;

  if (isConnected) {
    livePositions.forEach((p) => {
      const decimals = getAssetDecimals(p.asset);
      const factor = 10 ** decimals;
      const activeNum = Number(p.activeShares) / factor;
      const pendingNum = Number(p.pendingShares) / factor;
      const totalNum = activeNum + pendingNum;
      if (p.asset === "TYRN" || p.asset === "TYR") {
        tyrStakeCount += totalNum;
        tyrStakeUsd += totalNum * 0.0004;
      } else {
        baseStakeTotal += p.estimatedUsdValue;
      }
    });
  }

  const currentBoost =
    baseStakeTotal > 0
      ? (1 + 0.5 * Math.min(1, tyrStakeUsd / baseStakeTotal)).toFixed(2)
      : "1.00";
  const estQuota = (
    baseStakeTotal * Number(currentBoost) * 0.0028 +
    tyrStakeUsd * 0.0035
  ).toFixed(2);

  const stakedAmount = (symbol: string) => {
    if (isConnected) {
      const pos = livePositions.find((p) => p.asset === symbol);
      if (!pos) return 0;
      const decimals = getAssetDecimals(symbol);
      return (Number(pos.activeShares) + Number(pos.pendingShares)) / (10 ** decimals);
    }
    return 0;
  };

  const handleInputChange = (sym: string, val: string) => {
    setInputs((prev) => ({ ...prev, [sym]: val }));
  };

  // Open Staking Modal
  const handleOpenStake = (asset: AssetDef) => {
    if (!isConnected) {
      openWalletOnboarding();
      return;
    }
    resetTxState();
    const amt = inputs[asset.symbol] || "";
    setModalAsset(asset);
    setModalAmount(amt);
    setModalError("");
    setModalOpen(true);
  };

  // Testnet Faucet Mint Handler
  const handleFaucetMint = async (asset: AssetDef) => {
    if (!isConnected) {
      openWalletOnboarding();
      return;
    }
    const tokenAddr = resolveAssetAddress(asset.symbol);
    if (!tokenAddr) {
      alert(`Token address not configured for ${asset.symbol}`);
      return;
    }

    try {
      resetTxState();
      const decimals = getAssetDecimals(asset.symbol);
      const amount = safeParseUnits("1000", decimals);
      await mintMockTokens(tokenAddr, amount);
      await refreshOnChainBalances();
    } catch (err) {
      console.error("Faucet mint error:", err);
    }
  };

  // Step 1: Approve Token Allowance
  const handleApprove = async () => {
    if (!modalAsset) return;
    const tokenAddr = resolveAssetAddress(modalAsset.symbol);
    if (!tokenAddr) {
      setModalError(`Token address not configured for ${modalAsset.symbol}`);
      return;
    }

    try {
      setModalError("");
      const num = Number(modalAmount);
      if (num <= 0) {
        setModalError("Please enter a valid amount greater than 0.");
        return;
      }
      const decimals = getAssetDecimals(modalAsset.symbol);
      const amount = safeParseUnits(modalAmount, decimals);
      await approveToken(tokenAddr, amount);
      await refreshOnChainBalances();
    } catch (err) {
      const cleanErr = formatWalletError(err, "Approval failed.");
      if (cleanErr) setModalError(cleanErr);
    }
  };

  // Step 2: Confirm Stake
  const handleConfirmStake = async () => {
    if (!modalAsset) return;
    const tokenAddr = resolveAssetAddress(modalAsset.symbol);
    if (!tokenAddr) {
      setModalError(`Token address not configured for ${modalAsset.symbol}`);
      return;
    }

    try {
      setModalError("");
      const num = Number(modalAmount);
      const available = getAvailableBalance(modalAsset.symbol);
      if (num <= 0) {
        setModalError("Please enter an amount greater than zero.");
        return;
      }
      if (num > available) {
        setModalError(`Amount exceeds available balance of ${fmtAmount(modalAsset.symbol, available)} ${modalAsset.symbol}.`);
        return;
      }

      if (!isConnected) {
        setModalOpen(false);
        openWalletOnboarding();
        return;
      }

      const decimals = getAssetDecimals(modalAsset.symbol);
      const amount = safeParseUnits(modalAmount, decimals);
      await stakeTokens(tokenAddr, amount);
      setInputs((prev) => ({ ...prev, [modalAsset.symbol]: "" }));
      await refreshOnChainBalances();
      await refreshPositions();
    } catch (err) {
      const cleanErr = formatWalletError(err, "Staking transaction failed.");
      if (cleanErr) setModalError(cleanErr);
    }
  };

  // Open Unstake Modal
  const handleOpenUnstake = (symbol: string, maxAmount: number) => {
    const addr = resolveAssetAddress(symbol);
    resetTxState();
    setUnstakeAsset(symbol);
    setUnstakeAssetAddress(addr);
    setUnstakeMaxAmount(maxAmount);
    setUnstakeAmount(String(maxAmount));
    setUnstakeError("");
    setUnstakeModalOpen(true);
  };

  // Confirm Request Unstake
  const handleConfirmUnstake = async () => {
    if (!unstakeAssetAddress) {
      setUnstakeError("Asset address not found");
      return;
    }
    const num = Number(unstakeAmount);
    if (num <= 0 || num > unstakeMaxAmount) {
      setUnstakeError(`Please enter an amount between 0 and ${unstakeMaxAmount}.`);
      return;
    }

    try {
      setUnstakeError("");
      const decimals = getAssetDecimals(unstakeAsset);
      const amount = safeParseUnits(unstakeAmount, decimals);
      await requestUnstakeTokens(unstakeAssetAddress, amount);
      await refreshPositions();
      await refreshOnChainBalances();
    } catch (err) {
      const cleanErr = formatWalletError(err, "Unstake request failed.");
      if (cleanErr) setUnstakeError(cleanErr);
    }
  };

  // Withdraw Matured Cooldown
  const handleWithdrawRequest = async (tokenAddress: Address, requestIdStr: string) => {
    try {
      resetTxState();
      const requestId = BigInt(requestIdStr);
      await withdrawTokens(tokenAddress, requestId);
      await refreshPositions();
      await refreshOnChainBalances();
    } catch (err) {
      const cleanErr = formatWalletError(err, "Withdrawal failed.");
      if (cleanErr) console.error("Withdraw error:", cleanErr);
    }
  };

  // Modal validation helpers
  const modalAvailable = modalAsset ? getAvailableBalance(modalAsset.symbol) : 0;
  const modalNumeric = Number(modalAmount) || 0;
  const modalInvalid =
    !modalAsset || !modalAmount || modalNumeric <= 0 || modalNumeric > modalAvailable;

  const modalDecimals = modalAsset ? getAssetDecimals(modalAsset.symbol) : 18;
  const modalRequiredBigInt = modalAmount && !Number.isNaN(Number(modalAmount)) && Number(modalAmount) > 0
    ? safeParseUnits(modalAmount, modalDecimals)
    : 0n;

  const currentAllowance = modalAsset ? getAssetAllowance(modalAsset.symbol) : 0n;
  const isApproved = isConnected ? currentAllowance >= modalRequiredBigInt && modalRequiredBigInt > 0n : true;

  return (
    <main className="page-stake">
      <header className="page-head">
        <svg className="orn" viewBox="-100 -100 200 200" aria-hidden="true">
          <use href="#murex" />
        </svg>
        <div className="wrap">
          <div>
            <div className="eyebrow">Stake</div>
            <h1>Stake once, use every model.</h1>
            <p className="lead">
              USDG and Stock Tokens give you base quota. $TYRN adds a boost of up to 1.5×. New stakes count from the next
              epoch at 00:00 UTC.
            </p>
          </div>
          <div className="aside">
            <div className="telemetry-box" role="status" aria-label="Protocol parameters">
              <div className="telemetry-item">
                <span className="telemetry-label">Network</span>
                <span className="telemetry-value">{activeNetwork.label}</span>
              </div>
              <div className="telemetry-item">
                <span className="telemetry-label">Cooldown</span>
                <span className="telemetry-value">7 Days</span>
              </div>
              <div className="telemetry-item">
                <span className="telemetry-label">Next Epoch</span>
                <span className="telemetry-value gold" id="epochIn" suppressHydrationWarning>
                  {nextEpochCountdown}
                </span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="wrap">
        <div className="section" style={{ paddingBottom: 0 }}>
          {/* Conditional Wrong-Network Banner (Only shown if connected to incorrect chain) */}
          {isConnected && !isCorrectChain && (
            <div className="banner" id="networkBanner" data-reveal style={{ borderColor: "rgba(214, 69, 69, 0.4)", background: "rgba(214, 69, 69, 0.08)", marginBottom: "20px" }}>
              <svg className="ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" style={{ color: "var(--danger)" }}>
                <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
              </svg>
              <div className="grow">
                <span>
                  <b>Wrong network detected.</b> Please switch your wallet to {activeNetwork.label} (Chain ID {activeNetwork.chainId}) to stake and manage assets.
                </span>
              </div>
            </div>
          )}

          {/* 4 Summary Tiles */}
          <div className="tiles summary" data-reveal aria-live="polite">
            <div className="tile">
              <div className="label">Base stake value</div>
              <div className="value" id="sBase">
                ${baseStakeTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              <div className="foot">USDG + Stock Tokens</div>
            </div>
            <div className="tile">
              <div className="label">$TYRN staked</div>
              <div className="value" id="sTyr">
                {tyrStakeCount.toLocaleString("en-US")}
              </div>
              <div className="foot" id="sTyrUsd">
                ${tyrStakeUsd.toFixed(2)} at market price
              </div>
            </div>
            <div className="tile">
              <div className="label">Boost</div>
              <div className="value" id="sBoost">
                {currentBoost}×
              </div>
              <div className="foot">1 + 0.5 × min(1, TYRN ÷ base)</div>
            </div>
            <div className="tile">
              <div className="label">Estimated quota / day</div>
              <div className="value" id="sQuota">
                ${estQuota}
              </div>
              <div className="foot" id="sQuotaFoot">
                from active positions
              </div>
            </div>
          </div>
        </div>

        {/* Toolbar & Filter Tabs */}
        <section className="section" aria-labelledby="assetsH">
          <div className="toolbar">
            <h2 id="assetsH">Assets</h2>
            <div className="seg" role="group" aria-label="Filter assets">
              <button
                type="button"
                data-f="all"
                aria-pressed={filter === "all"}
                onClick={() => setFilter("all")}
              >
                All
              </button>
              <button
                type="button"
                data-f="base"
                aria-pressed={filter === "base"}
                onClick={() => setFilter("base")}
              >
                USDG
              </button>
              <button
                type="button"
                data-f="stock"
                aria-pressed={filter === "stock"}
                onClick={() => setFilter("stock")}
              >
                Stock Tokens
              </button>
              <button
                type="button"
                data-f="boost"
                aria-pressed={filter === "boost"}
                onClick={() => setFilter("boost")}
              >
                $TYRN
              </button>
            </div>
          </div>

          {/* Asset Cards Grid */}
          <div className="assets-grid" id="assetsGrid">
            {filteredAssets.map((asset) => {
              const val = inputs[asset.symbol] || "";
              const available = getAvailableBalance(asset.symbol);
              const numeric = Number(val);
              const amountError = Boolean(val) && (!Number.isFinite(numeric) || numeric <= 0 || numeric > available);
              const canStake = Boolean(val) && !amountError;
              const tokenAddr = resolveAssetAddress(asset.symbol);
              const isConfiguredOnChain = Boolean(tokenAddr);

              return (
                <div key={asset.symbol} className="tilt">
                  <div className={`acard ${asset.type}`}>
                    <div className="shine" />
                    
                    <div className="top top-header-divider">
                      <div style={{ display: "flex", alignItems: "center", gap: "12px", width: "100%" }}>
                        <TokenLogo symbol={asset.symbol} size={44} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                            <div className="tk">{asset.symbol === "TYRN" || asset.symbol === "TYR" ? "$TYRN" : asset.symbol}</div>
                            <span className={`chip ${asset.type === "boost" ? "chip-gold" : ""}`}>{asset.pool}</span>
                          </div>
                          <div className="nm">{asset.name}</div>
                        </div>
                      </div>
                    </div>

                    <div className="meta">
                      <span>Price</span>
                      <b>
                        ${asset.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                      </b>
                    </div>
                    <div className="meta">
                      <span>Your stake</span>
                      <b>{fmtAmount(asset.symbol, stakedAmount(asset.symbol))}</b>
                    </div>

                    {tokenAddr && (
                      <div className="addr" title="Token Address">
                        Token {tokenAddr.slice(0, 6)}…{tokenAddr.slice(-4)}
                        {asset.feed && ` · feed ${asset.feed.slice(0, 6)}…${asset.feed.slice(-4)}`}
                      </div>
                    )}

                    <form onSubmit={(e) => { e.preventDefault(); handleOpenStake(asset); }}>
                      <label className="sr-only" htmlFor={`amt-${asset.symbol}`}>
                        Amount of {asset.symbol} to stake
                      </label>
                      <div className="inp">
                        <input
                          id={`amt-${asset.symbol}`}
                          type="number"
                          inputMode="decimal"
                          placeholder="0.00"
                          autoComplete="off"
                          value={val}
                          onChange={(e) => handleInputChange(asset.symbol, e.target.value)}
                          min="0"
                          max={available}
                          step="any"
                          aria-invalid={amountError}
                          disabled={!isConfiguredOnChain && isConnected}
                        />
                        <span className="unit">{asset.symbol}</span>
                        <button
                          className="max"
                          type="button"
                          onClick={() => {
                            if (!isConnected) {
                              openWalletOnboarding();
                              return;
                            }
                            handleInputChange(asset.symbol, String(available));
                          }}
                          disabled={!isConfiguredOnChain && isConnected}
                        >
                          MAX
                        </button>
                      </div>

                      <div className={`hint${amountError ? " err" : ""}`}>
                        {amountError
                          ? `Available: ${fmtAmount(asset.symbol, available)} ${asset.symbol}`
                          : isConnected
                            ? `Balance: ${fmtAmount(asset.symbol, available)} ${asset.symbol}`
                            : "Connect a wallet to see your balance"}
                      </div>

                      {/* Testnet Faucet Button for USDG and TYRN */}
                      {isConnected && activeNetwork.name === "testnet" && (asset.symbol === "USDG" || asset.symbol === "TYRN" || asset.symbol === "TYR") && tokenAddr && (
                        <div style={{ marginTop: "4px", marginBottom: "8px", display: "flex", justifyContent: "flex-end" }}>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            style={{ fontSize: "11px", height: "26px", padding: "0 8px", borderColor: "rgba(212,175,55,0.3)" }}
                            disabled={txState.isBusy}
                            onClick={() => handleFaucetMint(asset)}
                          >
                            {txState.step === "minting" ? "Minting 1,000…" : `💧 Mint 1,000 ${asset.symbol}`}
                          </button>
                        </div>
                      )}

                      <button
                        className="btn btn-primary btn-block"
                        type="submit"
                        disabled={(isConnected && (!canStake || !isConfiguredOnChain)) || txState.isBusy}
                      >
                        {!isConnected
                          ? "Connect wallet"
                          : !isConfiguredOnChain
                            ? "Coming soon on testnet"
                            : amountError
                              ? "Insufficient balance"
                              : `Stake ${asset.symbol}`}
                      </button>
                    </form>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Your Positions Table */}
        <section className="section" aria-labelledby="posH">
          <div className="section-title">
            <h2 id="posH">Your positions</h2>
            <p>
              Request unstake stops quota for that position right away. You can withdraw the tokens after the 7-day cooldown.
            </p>
          </div>
          <div className="table-wrap" data-reveal>
            <table className="data" id="posTable">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th className="num">Active Amount</th>
                  <th className="num">Pending Next Epoch</th>
                  <th className="num">Value</th>
                  <th>Status</th>
                  <th className="num">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody id="posBody">
                {!isConnected ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: "center", padding: "36px", color: "var(--text-sub)" }}>
                      <div style={{ marginBottom: "12px", fontSize: "14px" }}>
                        Connect your wallet to view active staking positions and daily inference quota.
                      </div>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={openWalletOnboarding}
                      >
                        Connect wallet
                      </button>
                    </td>
                  </tr>
                ) : livePositions.length === 0 && liveCooldowns.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: "center", padding: "32px", color: "var(--text-sub)" }}>
                      No active staking positions yet. Stake USDG above to receive daily inference quota.
                    </td>
                  </tr>
                ) : (
                  <>
                    {/* Active & Pending Positions */}
                    {livePositions.map((pos) => {
                      const decimals = getAssetDecimals(pos.asset);
                      const factor = 10 ** decimals;
                      const activeAmt = Number(pos.activeShares) / factor;
                      const pendingAmt = Number(pos.pendingShares) / factor;
                      const totalAmt = activeAmt + pendingAmt;
                      if (totalAmt <= 0) return null;

                      return (
                        <tr key={pos.assetAddress}>
                          <td data-l="Asset">
                            <b className="mono" style={{ color: "var(--gold-500)" }}>
                              {pos.asset}
                            </b>
                          </td>
                          <td className="num" data-l="Active">{fmtAmount(pos.asset, activeAmt)}</td>
                          <td className="num" data-l="Pending">
                            {pendingAmt > 0 ? (
                              <span style={{ color: "var(--gold-400)" }}>
                                +{fmtAmount(pos.asset, pendingAmt)}
                              </span>
                            ) : (
                              "-"
                            )}
                          </td>
                          <td className="num" data-l="Value">${pos.estimatedUsdValue.toLocaleString("en-US", { minimumFractionDigits: 2 })}</td>
                          <td data-l="Status">
                            {activeAmt > 0 ? (
                              <span className="chip" style={{ color: "var(--success)", borderColor: "rgba(46,158,107,.4)" }}>
                                Active
                              </span>
                            ) : (
                              <span className="chip chip-warn">
                                Pending epoch
                              </span>
                            )}
                          </td>
                          <td className="num pos-actions">
                            {activeAmt > 0 && (
                              <button
                                type="button"
                                className="btn btn-warn btn-sm"
                                style={{ height: "32px", padding: "0 12px", fontSize: "12px" }}
                                disabled={txState.isBusy}
                                onClick={() => handleOpenUnstake(pos.asset, activeAmt)}
                              >
                                Request Unstake
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}

                    {/* Cooldown Requests */}
                    {liveCooldowns.map((cd) => {
                      const decimals = getAssetDecimals(cd.asset);
                      const sharesAmt = Number(cd.shares) / (10 ** decimals);
                      const unlockTimeMs = Number(cd.unlockAt) * 1000;
                      const isUnlocked = Date.now() >= unlockTimeMs;
                      const remainingSec = Math.max(0, Math.floor((unlockTimeMs - Date.now()) / 1000));
                      const d = Math.floor(remainingSec / 86400);
                      const h = Math.floor((remainingSec % 86400) / 3600);

                      return (
                        <tr key={cd.id} style={{ background: "rgba(255, 180, 0, 0.03)" }}>
                          <td data-l="Asset">
                            <b className="mono" style={{ color: "var(--series-1)" }}>
                              {cd.asset}
                            </b>
                            <small style={{ display: "block", color: "var(--text-sub)", fontSize: "11px" }}>
                              Request #{cd.requestId}
                            </small>
                          </td>
                          <td className="num" data-l="Active">-</td>
                          <td className="num" data-l="Cooldown">{fmtAmount(cd.asset, sharesAmt)}</td>
                          <td className="num" data-l="Value">-</td>
                          <td data-l="Status">
                            {isUnlocked ? (
                              <span className="chip" style={{ color: "var(--series-2)", borderColor: "rgba(80, 160, 255, 0.4)" }}>
                                Ready to Withdraw
                              </span>
                            ) : (
                              <span className="chip chip-warn">
                                Cooldown {d}d {h}h
                              </span>
                            )}
                          </td>
                          <td className="num pos-actions">
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              style={{ height: "32px", padding: "0 12px", fontSize: "12px" }}
                              disabled={!isUnlocked || txState.isBusy}
                              onClick={() => handleWithdrawRequest(cd.assetAddress as Address, cd.requestId)}
                            >
                              {txState.step === "withdrawing" ? "Withdrawing…" : "Withdraw"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* How Staking Works (6 Rules Grid) */}
        <section className="section" aria-labelledby="rulesH">
          <h2 id="rulesH" style={{ marginBottom: "18px" }}>
            How staking works
          </h2>
          <div className="rules">
            <div data-reveal>
              <h3>One-epoch delay</h3>
              <p>Stakes count from the next epoch (00:00 UTC). This stops flash-staking.</p>
            </div>
            <div data-reveal>
              <h3>7-day cooldown</h3>
              <p>Requesting unstake ends quota for that position at once. Withdraw after 7 days.</p>
            </div>
            <div data-reveal>
              <h3>Same token back</h3>
              <p>Withdrawals return exactly the token you staked. No conversion, so you keep your exposure.</p>
            </div>
            <div data-reveal>
              <h3>No admin access</h3>
              <p>No admin function can move your assets. Pause stops deposits, never withdrawals.</p>
            </div>
            <div data-reveal>
              <h3>No minimum</h3>
              <p>Small stakes still earn a pro-rata share. Splitting across wallets adds nothing.</p>
            </div>
            <div data-reveal>
              <h3>Region limits</h3>
              <p>Stock Tokens are not available in the US, UK, Canada, Switzerland or UAE.</p>
            </div>
          </div>
        </section>
      </div>

      {/* Stake Modal Dialog */}
      {modalOpen && modalAsset && (
        <div className="modal" id="txModal" role="dialog" aria-modal="true" style={{ display: "grid" }}>
          <div
            className="modal-backdrop"
            onClick={() => {
              if (!txState.isBusy) {
                setModalOpen(false);
                resetTxState();
              }
            }}
          />
          <div className="modal-card">
            <div className="modal-head">
              <h3 id="txTitle">Stake {modalAsset.symbol}</h3>
              <button
                className="icon-btn"
                type="button"
                onClick={() => {
                  if (!txState.isBusy) {
                    setModalOpen(false);
                    resetTxState();
                  }
                }}
                aria-label="Close"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            <p className="preview-note" id="txPreview">
              {activeNetwork.label} · Staking {modalAmount || "0"} {modalAsset.symbol}
            </p>

            <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
              {["25%", "50%", "75%", "100%"].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ flex: 1, fontSize: "11px", height: "28px" }}
                  onClick={() => {
                    const ratio = parseInt(pct) / 100;
                    const val = (modalAvailable * ratio).toFixed(modalAsset.symbol === "TYRN" || modalAsset.symbol === "TYR" ? 0 : 2);
                    setModalAmount(val);
                    setModalError("");
                  }}
                >
                  {pct}
                </button>
              ))}
            </div>

            <ol className="steps">
              <li className={isApproved ? "done" : "active"}>
                <span className="dot">{isApproved ? "✓" : "1"}</span>
                <div>
                  <b>Approve Token Allowance</b>
                  <small>
                    {isApproved
                      ? "Allowance approved on-chain"
                      : "Grants StakeManager contract permission to deposit"}
                  </small>
                </div>
              </li>
              <li className={isApproved ? (txState.step === "success" ? "done" : "active") : ""}>
                <span className="dot">{txState.step === "success" ? "✓" : "2"}</span>
                <div>
                  <b>Confirm Stake on {activeNetwork.label}</b>
                  <small>Locks tokens into vault and registers shares for daily epoch rollover</small>
                </div>
              </li>
            </ol>

            {txState.txHash && (
              <div style={{ marginBottom: "12px", fontSize: "12px", textAlign: "center" }}>
                <a
                  href={getExplorerTxUrl(txState.txHash)}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--gold-400)", textDecoration: "underline" }}
                >
                  View on Explorer ↗
                </a>
              </div>
            )}

            <p
              className={`wm-msg ${modalError || modalInvalid ? "err" : "ok"}`}
              style={{ marginBottom: "16px" }}
              role={modalError ? "alert" : undefined}
            >
              {modalError
                ? modalError
                : txState.error
                  ? txState.error
                  : txState.step === "success"
                    ? "Transaction confirmed successfully!"
                    : modalInvalid
                      ? `Enter an amount up to ${fmtAmount(modalAsset.symbol, modalAvailable)} ${modalAsset.symbol}.`
                      : !isApproved
                        ? "Approve token allowance to proceed."
                        : "Ready to confirm stake on-chain."}
            </p>

            {txState.step === "success" ? (
              <button
                className="btn btn-primary btn-lg"
                style={{ width: "100%" }}
                type="button"
                onClick={() => {
                  setModalOpen(false);
                  resetTxState();
                }}
              >
                Done
              </button>
            ) : !isApproved ? (
              <button
                className="btn btn-primary btn-lg"
                style={{ width: "100%" }}
                type="button"
                onClick={handleApprove}
                disabled={modalInvalid || txState.isBusy}
              >
                {txState.step === "approving" ? "Approving on-chain…" : `Step 1: Approve ${modalAsset.symbol}`}
              </button>
            ) : (
              <button
                className="btn btn-primary btn-lg"
                style={{ width: "100%" }}
                type="button"
                onClick={handleConfirmStake}
                disabled={modalInvalid || txState.isBusy}
              >
                {txState.step === "staking" ? "Confirming on-chain…" : "Step 2: Confirm Stake"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Unstake Modal Dialog */}
      {unstakeModalOpen && (
        <div className="modal" id="unstakeModal" role="dialog" aria-modal="true" style={{ display: "grid" }}>
          <div
            className="modal-backdrop"
            onClick={() => {
              if (!txState.isBusy) {
                setUnstakeModalOpen(false);
                resetTxState();
              }
            }}
          />
          <div className="modal-card">
            <div className="modal-head">
              <h3>Request Unstake {unstakeAsset}</h3>
              <button
                className="icon-btn"
                type="button"
                onClick={() => {
                  if (!txState.isBusy) {
                    setUnstakeModalOpen(false);
                    resetTxState();
                  }
                }}
                aria-label="Close"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            <p className="preview-note">
              Requesting unstake ends quota for this position immediately. Tokens will enter a 7-day cooldown before withdrawal.
            </p>

            <div className="inp" style={{ marginBottom: "12px" }}>
              <input
                type="number"
                inputMode="decimal"
                value={unstakeAmount}
                onChange={(e) => setUnstakeAmount(e.target.value)}
                min="0"
                max={unstakeMaxAmount}
                step="any"
              />
              <span className="unit">{unstakeAsset}</span>
              <button
                className="max"
                type="button"
                onClick={() => setUnstakeAmount(String(unstakeMaxAmount))}
              >
                MAX
              </button>
            </div>

            {txState.txHash && (
              <div style={{ marginBottom: "12px", fontSize: "12px", textAlign: "center" }}>
                <a
                  href={getExplorerTxUrl(txState.txHash)}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--gold-400)", textDecoration: "underline" }}
                >
                  View on Explorer ↗
                </a>
              </div>
            )}

            <p
              className={`wm-msg ${unstakeError ? "err" : "ok"}`}
              style={{ marginBottom: "16px" }}
              role={unstakeError ? "alert" : undefined}
            >
              {unstakeError
                ? unstakeError
                : txState.error
                  ? txState.error
                  : txState.step === "success"
                    ? "Unstake requested! Cooldown started."
                    : `Available to unstake: ${fmtAmount(unstakeAsset, unstakeMaxAmount)} ${unstakeAsset}`}
            </p>

            {txState.step === "success" ? (
              <button
                className="btn btn-primary btn-lg"
                style={{ width: "100%" }}
                type="button"
                onClick={() => {
                  setUnstakeModalOpen(false);
                  resetTxState();
                }}
              >
                Done
              </button>
            ) : (
              <button
                className="btn btn-warn btn-lg"
                style={{ width: "100%" }}
                type="button"
                onClick={handleConfirmUnstake}
                disabled={txState.isBusy || Number(unstakeAmount) <= 0 || Number(unstakeAmount) > unstakeMaxAmount}
              >
                {txState.step === "unstaking" ? "Requesting on-chain…" : "Confirm Request Unstake"}
              </button>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
