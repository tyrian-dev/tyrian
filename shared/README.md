# Shared Layer

Workspace ini berisi kode yang dibagikan antara **frontend**, **backend**, **indexer**, dan script.

Di sinilah loader konfigurasi chain dan ABI kontrak diletakkan agar proyek memiliki
*single source of truth*.

## Struktur

- `chains/index.ts` - Daftar jaringan (EVM) yang didukung.
- `contracts/addresses.ts` - Loader manifest per chain. **Bukan** hasil generate.
- `contracts/abis/` - ABI TypeScript (dihasilkan otomatis oleh `bun run sync`).
- `types/` - Tipe TypeScript yang dibagikan frontend & backend.

## Sumber alamat

Alamat kontrak, token, feed, Safe/timelock, start block, dan feature flag berada di:

```text
config/networks/testnet.json
config/networks/mainnet.json
```

Aturan:

- Jangan menaruh alamat kontrak di `.env` atau file komponen.
- `null` berarti belum dikonfigurasi. Jangan memakai `0x000...000` sebagai fallback.
- Gunakan `getContractAddress()` jika alamat wajib ada; error harus terlihat jelas.
- Gunakan `findContractAddress()` hanya jika alamat boleh belum tersedia.
- `StockVault` adalah satu vault per ticker. Gunakan `getStockVault(ticker)` atau
  `getStockVaults()`; jangan memakai satu alamat untuk semua ticker.
- `assertManifestValid()` memvalidasi struktur manifest untuk network apa pun.
  `getManifestIssues()` mengembalikan daftar masalahnya untuk script/CI.
- `assertMainnetReady()` dipakai sebelum deploy/CI mainnet.
  `getMainnetReadinessIssues()` mengembalikan daftar alamat/flag yang belum siap.
  Jika feature flag Stock Token aktif, semua ticker yang `enabled` wajib punya
  `address`, `feed`, dan `vault`. Flag `morpho`/`ponsDirectClaim` juga wajib punya
  alamat eksternal yang sesuai.

Pilih network lewat `NEXT_PUBLIC_NETWORK` (frontend) atau `TYRIAN_NETWORK`/`APP_ENV`
(backend/indexer/script). Chain ID berasal dari manifest.

`contracts/abis/` tetap ditimpa setiap kali `bun run sync` dijalankan. Jangan edit
file di dalam folder itu secara manual.
