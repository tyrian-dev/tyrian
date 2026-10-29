/**
 * Sanitizes wallet and viem errors to ensure user-friendly feedback.
 * Specifically handles user transaction rejections gracefully by returning null,
 * avoiding scary red error boxes or raw viem stack traces.
 */
export function formatWalletError(err: unknown, defaultMessage = "Transaction failed"): string | null {
  if (!err) return null;

  const msg = (err as Error)?.message || String(err);
  const code = (err as { code?: number })?.code;

  // Code 4001 or standard user rejection / cancellation strings
  if (
    code === 4001 ||
    msg.includes("User rejected") ||
    msg.includes("User denied") ||
    msg.includes("user rejected") ||
    msg.includes("user denied") ||
    msg.includes("User cancelled") ||
    msg.includes("user cancelled")
  ) {
    return null; // Return null: normal user action, should not display scary red box
  }

  if (msg.includes("insufficient funds")) {
    return "Insufficient funds in your wallet to cover gas fees.";
  }

  // Strip viem noise: "Details:", "Version: viem@...", etc.
  const clean = msg.split("Version:")[0].split("Details:")[0].split("\n")[0].trim();
  if (!clean || clean.length < 5) return defaultMessage;
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}
