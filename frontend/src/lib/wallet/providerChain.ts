import type { Config, Connector } from "wagmi";

export type WalletProvider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  isPhantom?: boolean;
};

export async function getConnectorProvider(
  connector?: Connector,
): Promise<WalletProvider | undefined> {
  if (!connector) return undefined;
  const provider = await connector.getProvider();
  return (provider as unknown as WalletProvider | undefined) ?? undefined;
}

export async function readProviderChainId(
  provider: WalletProvider,
): Promise<number> {
  const value = await provider.request({ method: "eth_chainId" });
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error("Wallet returned an invalid chain ID.");
  }
  return Number.parseInt(value, 16);
}

export function isPhantomConnector(connector?: Connector): boolean {
  if (!connector) return false;
  const rdns = Array.isArray(connector.rdns)
    ? connector.rdns
    : connector.rdns
      ? [connector.rdns]
      : [];
  return [connector.id, connector.name, ...rdns].some(
    (value) => typeof value === "string" && /phantom/i.test(value),
  );
}

/**
 * wagmi normally updates the connection chain from the connector's
 * `chainChanged` event. Some wallets (notably Phantom when the network is not
 * active) resolve `wallet_switchEthereumChain` without changing or emitting.
 * Once we have verified `eth_chainId` ourselves, mirror the real provider chain
 * into wagmi so sign-in and the onboarding step use the same chain.
 */
export function syncConnectionChain(
  config: Config,
  connector: Connector,
  chainId: number,
): void {
  config.setState((state) => {
    const connection = state.connections.get(connector.uid);
    if (!connection || connection.chainId === chainId) return state;

    const connections = new Map(state.connections);
    connections.set(connector.uid, { ...connection, chainId });

    return { ...state, connections };
  });
}
