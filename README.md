# Tyrian ($TYR)

Tyrian adalah protokol staking dan AI inference quota di Robinhood Chain.
Monorepo ini berisi kontrak, frontend, backend, indexer, dan shared config yang
dipakai bersama.

## Tech Stack

- **Contracts**: Foundry, Solidity `^0.8.26`, OpenZeppelin
- **Frontend**: Next.js, React, TypeScript, wagmi/viem, RainbowKit
- **Backend**: Hono, Drizzle ORM, Bun, PostgreSQL, Redis
- **Indexer**: Ponder + Postgres
- **Shared**: network manifest, loader alamat, ABI auto-sync
- **Package Manager**: Bun workspaces

## Struktur Monorepo

```text
contracts/        Foundry: src, test, script deploy/configure/verify
frontend/         Next.js: UI produk kanonis
backend/          Hono API: auth, keys, gateway, quota, treasury
indexer/          Ponder: event handler dan read model
shared/           Loader manifest, ABI, tipe bersama
config/networks/  testnet.json dan mainnet.json (satu-satunya sumber alamat)
docs/             Plan, runbook, referensi, QA
tyrian-site/      Template UI/referensi; bukan produk
```

## Prinsip Network

- Satu kode untuk testnet dan mainnet.
- Pindah network hanya lewat `config/networks/*.json`, env selector, dan secrets.
- Alamat kontrak **tidak** disimpan di `.env` atau komponen.
- `mainnet.json` harus berisi alamat terverifikasi, `startBlock`, dan
  `verification: "verified"` sebelum produksi.
- `assertMainnetReady()` gagal tertutup selama manifest belum lengkap.

Pilih network:

```dotenv
NEXT_PUBLIC_NETWORK=testnet
TYRIAN_NETWORK=testnet
INDEXER_NETWORK=testnet
```

## Memulai

### 1. Instalasi

```bash
bun install
cp .env.example .env
```

Isi hanya secret dan override RPC di `.env`. Alamat kontrak tetap di manifest.

### 2. Kontrak

```bash
bun run contracts:build
bun run contracts:test
bun run sync                 # regenerate ABI ke shared/contracts/abis
```

Detail deploy dan guard mainnet ada di [`contracts/README.md`](./contracts/README.md)
dan [`AGENT.md`](./AGENT.md).

### 3. Frontend

```bash
bun run dev:frontend
```

Buka `http://localhost:3000`.

### 4. Backend

```bash
bun run dev:backend
```

Health check: `http://localhost:3000/health`.

### 5. Indexer

Indexer membutuhkan Postgres dan manifest yang sudah berisi alamat serta
`startBlock`.

```bash
bun run dev:indexer
```

## Skrip

| Perintah | Deskripsi |
|---|---|
| `bun run dev:frontend` | Dev server Next.js |
| `bun run dev:backend` | Dev server Hono |
| `bun run dev:indexer` | Dev server Ponder |
| `bun run build` | Build production frontend |
| `bun run build:backend` | Bundle backend |
| `bun run typecheck` | Typecheck frontend, backend, dan config indexer |
| `bun run lint` | Lint frontend |
| `bun run verify:manifest` | Validasi manifest network aktif |
| `bun run verify:manifest:testnet` | Validasi struktur manifest testnet |
| `bun run verify:manifest:mainnet` | Gate readiness mainnet; gagal selama manifest belum lengkap |
| `bun run test:manifest` | Test guard manifest dan config network backend |
| `bun run contracts:build` | `forge build` |
| `bun run contracts:test` | `forge test` |
| `bun run sync` | Sinkronisasi ABI Foundry ke shared |

## Dokumentasi

- [`AGENT.md`](./AGENT.md) — aturan kerja, network manifest, Definition of Done.
- [`docs/reference/developer-brief.md`](./docs/reference/developer-brief.md) —
  brief produk; tidak boleh diubah tanpa keputusan eksplisit.
- [`docs/plans/`](./docs/plans/) — plan per domain dan status task.
- [`shared/README.md`](./shared/README.md) — loader manifest dan ABI.

## Keamanan

- Jangan commit `.env`, private key, atau secret.
- Gunakan wallet burner dan RPC privat untuk deploy.
- Mainnet tidak boleh memakai mock, alamat zero, EOA treasury/guardian, atau
  private key default Anvil.
- Jangan mengklaim audit, legal, atau compliance sebelum bukti tersedia.
- Mode `live` tidak boleh menampilkan data preview.
