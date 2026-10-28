# Tyrian Indexer (Ponder)

Indexer on-chain berbasis [Ponder](https://ponder.sh/) yang berfungsi sebagai read-model real-time untuk seluruh event kontrak Tyrian.

## Arsitektur & Peran

- **Daemon Persisten**: Berjalan 24/7 memantau blok baru di Robinhood Chain (Testnet `46630` / Mainnet `4663`) dengan latensi ingestion 1.0 – 3.0 detik.
- **Start Block**: Otomatis dibaca dari `config/networks/<network>.json` (`startBlock: 143500969` untuk testnet).
- **Transport Resilience**: Menggunakan Viem HTTP transport dengan `timeout: 60_000` ms dan `retryCount: 5` untuk mengatasi latensi RPC publik.

## Kontrak yang Diindeks

1. `StakeManager`: Event `Staked`, `UnstakeRequested`, `Withdrawn`, `AssetConfigUpdated`.
2. `UsdgVault`: Event `Harvested`.
3. `StockVault`: Event `Harvested`.
4. `FeeSplitter`: Event `FeesSplit`, `Burned` (`source = FEE`).
5. `BuybackBurner`: Event `Burned` (`source = BUYBACK`).
6. `TreasuryRouter`: Event `Routed`, `SplitUpdated`.

## Menjalankan Indexer

```bash
bun run dev:indexer       # Development mode (GraphQL UI di http://localhost:42069)
```

## Perubahan Kode → Reindex (Build ID Ponder)

Ponder 0.8 mengikat schema Postgres ke **build id** yang dihitung dari
`ponder.config.ts`, `ponder.schema.ts`, dan `indexer/src/**` (termasuk
`startBlock` serta alamat kontrak dari manifest). Mengubah salah satunya membuat
`ponder start` menolak schema lama:

```text
NonRetryableError: Schema 'ponder' was previously used by a different Ponder app.
```

Karena Ponder 0.8 tidak punya migration, data indexer harus dibangun ulang.
Guard `indexer/scripts/prepare-db.ts` berjalan sebelum Ponder dan menangani ini:

```bash
bun run fingerprint   # cetak hash + input (tanpa database)
bun run check-db      # exit 1 bila reindex diperlukan; menampilkan diff field
bun run reset-db      # drop schema + catat fingerprint baru (backfill ulang)
bun run start         # guard + ponder start (dipakai Railway)
```

| Variabel | Default | Catatan |
|---|---|---|
| `DATABASE_SCHEMA` | `ponder` | Harus sama dengan flag `--schema` Ponder |
| `PONDER_AUTO_RESET` | off | `1` = drop otomatis saat input berubah (testnet) |

Field manifest yang **tidak** diindeks (`contracts.TyrTwapOracle`,
`external.uniswapPool`, dll.) tidak memicu reindex. Prosedur operasional:
[`docs/runbooks/RUN-006-indexer-recovery.md`](../docs/runbooks/RUN-006-indexer-recovery.md) §5.C dan §7.
