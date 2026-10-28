# Tyrian Frontend (Next.js)

Frontend kanonis Tyrian berbasis [Next.js](https://nextjs.org/) (App Router), TypeScript, Tailwind CSS / custom Tyrian CSS, [RainbowKit](https://www.rainbowkit.com/), dan [Wagmi](https://wagmi.sh/).

> [!NOTE]
> `frontend/` adalah satu-satunya produk kanonis yang di-deploy ke production (Vercel). Folder `tyrian-site/` hanya merupakan template UI dan referensi desain statis.

## Halaman Utama

| Rute | Peran & Integrasi |
|---|---|
| `/` | Landing page dengan 3D Hero canvas dan ringkasan ekosistem |
| `/dashboard` | Meteran ring kuota harian, status staker live, pemetaan stake on-chain dari indexer, dan manajemen API key |
| `/stake` | Portal deposit, vault USDG & Stock Tokens, request unstake (cooldown 7 hari), dan penarikan pokok |
| `/playground` | Antarmuka chat AI OpenAI-compatible dengan pengawasan estimasi biaya kuota maksimum |
| `/models` | Katalog model AI yang diizinkan (allowlist) beserta transparansi harga token |
| `/treasury` | Portofolio perbendaharaan, rasio inflow WETH creator fee, dan pembagian 70/20/10 |
| `/docs` | Dokumentasi developer, spesifikasi endpoint gateway, dan panduan API key |

## Integrasi On-Chain Staking (`/stake`)

Halaman `/stake` terhubung langsung ke kontrak pintar [`StakeManager`](file:///D:/KERJA/Wealthy%20People/Projek%20Projek/tyrian/contracts/src/StakeManager.sol) via hook [`useStakeContract`](file:///D:/KERJA/Wealthy%20People/Projek%20Projek/tyrian/frontend/src/hooks/useStakeContract.ts):
- **Two-Step Execution:** Step 1 memeriksa `allowance` ERC20 (otomatis memicu `approve` jika diperlukan), kemudian Step 2 memicu `StakeManager.stake(asset, amount)`.
- **Cooldown & Penarikan:** Memulai unstake 7 hari via `requestUnstake(asset, amount)`, dan penarikan langsung via `withdraw(asset, requestId)`.
- **Testnet Faucet:** Memungkinkan satu-klik mint 1.000 testnet USDG/TYR langsung ke wallet di jaringan testnet.
- **Explorer Tracking:** Tautan langsung ke Robinhood Chain Blockscout untuk setiap transaksi.

## Menjalankan Frontend

```bash
bun run dev:frontend     # Development server di http://localhost:3000
bun run build            # Next.js production build
bun run lint             # ESLint check
```

## Konfigurasi Jaringan

Konfigurasi chain target, RPC, explorer, dan kontrak dibaca secara otomatis dari:
- `config/networks/testnet.json` (Robinhood Chain Testnet — Chain ID `46630`)
- `config/networks/mainnet.json` (Robinhood Chain Mainnet — Chain ID `4663`)
Melalui shared loader `@shared/contracts/addresses`.
