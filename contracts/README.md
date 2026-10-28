# Kontrak (Foundry)

Kontrak Tyrian memakai [Foundry](https://book.getfoundry.sh/) dan Solidity
`^0.8.26` dengan OpenZeppelin. Hardhat hanya tersisa sebagai dependency lama dan
bukan jalur build/deploy utama.

## Layout

```text
src/                  sumber kontrak (.sol)
src/interfaces/       IStakeVault, IYieldStrategy, IWETH, IBurnSource,
                      IAggregatorV3, ISwapRouterV3, IStockPriceOracle
src/oracles/          StockPriceOracle
src/vaults/           PrincipalVault, UsdgVault, StockVault
src/mocks/            mock local/testnet
test/                 unit, fuzz, dan invariant test Foundry (*.t.sol)
script/               deploy, configure, ownership, verify
script/lib/           MainnetGuards, TreasuryManifest
foundry.toml
```

Kontrak treasury:

- `TreasuryRouter` — split inflow 70% budget / 20% reserve / 10% portfolio,
  swap WETH→USDG dengan `minOut` + `deadline`, dan menyimpan WETH jika swap
  gagal (event `SwapFailed`, bukan revert).
- `PortfolioVault` — basket maksimum 8 Stock Token, cap 20% dari
  `treasuryTotalUsd` yang di-set owner, DCA mingguan dengan batas
  `dcaAmountUsd`, dan slippage maksimum yang divalidasi terhadap oracle.
  Eksekusi rebalance dan spread check ditunda sampai pool terverifikasi.
- `StockPriceOracle` — satu oracle per ticker, normalisasi harga ke 18 desimal,
  menolak harga negatif/nol, `updatedAt` nol, round tidak lengkap, dan feed
  stale di atas `maxStalePeriod` (default 96 jam, maksimum 7 hari).
  `checkPrice()` mengembalikan `false` dan meng-emit `PriceInvalid`/`PriceStale`
  untuk monitoring tanpa revert.

## Test

`forge test` menjalankan 274 test: unit, fuzz (256 run per test),
2 invariant suite dengan invariant lengkap (64 run × 100 call), lifecycle handler
test, validasi siklus penuh StockVault multi-asset, dan test access control/pause. Konfigurasi invariant ada di
`foundry.toml`; fuzz/invariant berjalan di semua suite CI yang menjalankan
`forge test`.

- `test/*Fuzz.t.sol` — vault, treasury router, oracle, portfolio, dan fee
  splitter/buyback.
- `test/AccessControl.t.sol` — matrix owner-only, two-step ownership, timelock
  `TimelockController` 48 jam, scope guardian, pause tidak memblokir exit, dan
  tidak ada jalur admin yang memindahkan aset user.
- `test/StakeManagerInvariant.t.sol` — share/principal, custody manager,
  request vs cooldown.
- `test/TreasuryRouterInvariant.t.sol` — recipient = `totalRouted`, tidak ada
  WETH/USDG/allowance tersisa.

## Coverage dan analisis statis

```bash
bun run contracts:coverage   # butuh Foundry 1.3.6, lihat catatan di bawah
bun run contracts:slither    # slither-analyzer 0.11.6 + solc 0.8.26
bun run contracts:aderyn     # aderyn 0.6.8 di PATH
```

`contracts:coverage` menghasilkan line coverage 88,70% untuk kontrak production
(`src/`, tanpa mock). Jalur utama: `BuybackBurner` 100%, `StockPriceOracle` 100%,
`TreasuryRouter` 97,06%, `PortfolioVault` 91,67%, `StakeManager` 88,98%.
Gate `> 95%` untuk jalur utama belum tercapai; gap ada di `StockVault` (68,42%)
dan `PrincipalVault` (82,20%).

Foundry 1.8.x gagal menjalankan `forge coverage` pada repo ini karena
`libs = ["../node_modules", "node_modules"]` membuat build-info memuat source
unit duplikat (`identifier 'IERC20' already declared`). Job CI coverage memakai
Foundry 1.3.6; job unit test tetap memakai 1.8.3.

Slither/Aderyn dijalankan lewat scope sementara dari
`scripts/static-analysis-scope.sh` agar dependency berada di dalam project root
(alasan yang sama). Hasil dan triase lengkap:
[`docs/security/static-analysis.md`](../docs/security/static-analysis.md);
paket audit: [`docs/security/audit-package.md`](../docs/security/audit-package.md).

## Perintah

Dari root repo:

```bash
bun run contracts:build                 # forge build --root contracts
bun run contracts:test                  # forge test --root contracts
bun run contracts:test:watch            # watch mode pengujian otomatis saat file disimpan
bun run contracts:format                # forge fmt --root contracts
bun run contracts:deploy:testnet        # deploy otomatis testnet + isi testnet.json + sync ABI
bun run contracts:preflight:mainnet     # periksa kesiapan manifest & guard mainnet (fail-closed)
bun run contracts:deploy:mainnet:guarded # deploy guarded ke mainnet setelah preflight lolos
bun run contracts:manifest:testnet      # verifikasi integritas manifest testnet
bun run contracts:manifest:mainnet      # verifikasi kesiapan manifest mainnet
bun run contracts:coverage              # forge coverage (Foundry 1.3.6)
bun run contracts:slither               # Slither pada scope production
bun run contracts:aderyn                # Aderyn pada scope production
bun run sync                            # regenerate ABI ke shared/contracts/abis
```

Dari folder `contracts`:

```bash
forge build
forge test -vv
```

## Deploy

Alamat final **tidak** ditulis di `.env`. Isi network manifest:

```text
config/networks/testnet.json
config/networks/mainnet.json
```

Otomatisasi deployment:
- **Testnet:** Jalankan `bun run contracts:deploy:testnet` dari root. Skrip ini secara otomatis mengeksekusi `DeployTyrian`, `DeployTreasury`, dan `DeployStockOracle`, membaca receipt transaksi, mengisi alamat kontrak dan `startBlock` ke `testnet.json`, dan menjalankan `bun run sync`.
- **Mainnet:** Jalankan `bun run contracts:preflight:mainnet` untuk memvalidasi kesiapan manifes dan guard sebelum menjalankan `bun run contracts:deploy:mainnet:guarded`.

### Alamat Deployment Aktif — Robinhood Chain Testnet (46630)

| Kontrak / Token | Alamat On-Chain |
|---|---|
| StakeManager | `0x7c78cd94901f400432fc37fe5fe2b85a32a90861` |
| UsdgVault | `0x969cc9b64405fdbb7c157c72dfbd0bf714b0e76b` |
| StockVault (TSLA) | `0x2e2f69b3c3dc26eae22447878bdc0bf05a200af0` |
| StockPriceOracle (TSLA) | `0x52f01351499c7d5d63e3aa157aace9dd7ffd1851` |
| FeeSplitter | `0xc48caf1424fcd61310448d87996e2f8ad280c473` |
| BuybackBurner | `0x32445e552f14c3216f331a39e7dd50a11e021fe0` |
| TreasuryRouter | `0x7557578f82b833ae77458a6e7bb7e659b5e91688` |
| PortfolioVault | `0xa8039ac65c40da7deda84064fe788a9c8b8752e1` |
| Mock USDG | `0xa1e6557c578c2422bee44069cdb82710a8906c62` |
| Mock TYR | `0xe0ee5fe8e29db7e20792bce6f9a8bc3c4BC95617` |
| Mock WETH | `0x97bae90aeda8cead58514cfc93e3ee9b9f4490e3` |
| Mock TSLA | `0x115fd21e78768cac1e1bd67bb69925cb57a5ac07` |

*Start Block untuk Indexer: `143500969`*

Urutan produksi manual/on-chain:

```text
DeployProtocol.s.sol       # core nyata, tanpa mock
DeployTreasury.s.sol       # TreasuryRouter + PortfolioVault
DeployStockOracle.s.sol    # satu StockPriceOracle per ticker
DeployStockVault.s.sol     # satu vault per ticker
ConfigureProtocol.s.sol
ConfigureTreasury.s.sol
ConfigureStockVault.s.sol
TransferOwnership.s.sol
VerifyMainnet.s.sol
```

Local/testnet memakai `DeployMocks.s.sol` lalu `DeployTyrian.s.sol`.
`DeployTyrian` menolak chain selain `31337`/`46630`.

Script deploy membaca secret dari environment atau Foundry keystore. Private key
tidak boleh ditulis di file yang di-commit. Untuk mainnet, `DeployProtocol`
menolak private key default Anvil, alamat zero, EOA treasury/guardian, owner
yang bukan kontrak, dan token/Safe/guardian yang tidak sama dengan
`config/networks/mainnet.json`.

Guard ada di `script/lib/MainnetGuards.sol` dan diuji oleh
`test/DeployGuard.t.sol`, `test/TreasuryDeployGuard.t.sol`,
`test/StockOracleDeployGuard.t.sol`, dan `test/TreasuryConfigureGuard.t.sol`
(T-17). `foundry.toml` memberi izin baca `../config` agar guard dapat mencocokkan
alamat dengan network manifest. `DeployTreasury` mewajibkan `external.budget` dan
`external.reserve` berbeda dan sudah terisi di manifest mainnet.
`DeployStockOracle` mencocokkan token/feed ke ticker yang sama, sedangkan
`ConfigureTreasury` mencocokkan router, portfolio, dan `external.dexRouter`
sebelum mengubah parameter. Jalankan `forge test` setelah mengubah guard.

Setelah deploy, isi alamat final, `startBlock`, dan `verification: "verified"` di
manifest. `assertMainnetReady()` harus lulus sebelum indexer/backfill atau CI
mainnet dijalankan.
