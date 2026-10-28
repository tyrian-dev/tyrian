# Tyrian Backend (AI Gateway & Quota Manager)

Aplikasi berbasis [Hono](https://hono.dev/) yang bertindak sebagai AI Gateway (OpenAI-compatible), Authenticator (SIWE), dan Quota Manager harian.

## Tanggung Jawab Utama

1. **Sign-In with Ethereum (SIWE) & Session Management**:
   - Autentikasi wallet pengguna berbasis EIP-4361.
   - Session cookie `httpOnly` dengan binding domain dan network chain ID yang ketat.
2. **AI Gateway (`POST /v1/chat/completions`)**:
   - Endpoint OpenAI-compatible dengan validasi allowlist model (Anthropic Claude, OpenAI, Meta Llama, Google, dll.).
   - Penegakan kuota *fail-closed*: menolak request pengguna tanpa kuota atau kuota habis dengan HTTP `402 quota_exceeded`.
   - Forwarding inferensi ke OpenRouter API dan pemotongan reservasi kuota per request.
3. **Quota & Epoch Engine (`GET /v1/quota`, `POST /api/epoch/run`)**:
   - Terintegrasi dengan Ponder Indexer untuk membaca saldo stake on-chain (`USDG`, `TSLA`, dll.) dan riwayat panen yield vault (`UsdgVault:Harvested`).
   - Menghitung kuota harian pro-rata dengan presisi 6 desimal, boost token TYR hingga 1.5x, tanpa nilai minimum buatan (wallet tanpa stake = $0.000000).
   - Menyimpan alokasi kuota ke Redis / in-memory store dan me-reset penggunaan harian setiap 00:00 UTC.
4. **API Key Lifecycle (`/api/keys`)**:
   - Manajemen API key `tyr_live_...` dengan penyimpanan hash SHA-256, rotasi key, dan pencabutan (*revocation*) instan.
5. **Treasury Aggregation Service (`/api/treasury/summary`, `/api/treasury/flow`)**:
   - Mengagregasi event indexer untuk hasil harvest vault (`UsdgVault:Harvested`), fee split WETH 80/20, dan burn token $TYR.
   - Menyediakan data timeline arus kas 30 hari (*inflow vs spend*), estimasi runway, dan portofolio kas protokol.
6. **PostgreSQL Persistent Storage (Drizzle ORM)**:
   - Database terpadu untuk `users`, `api_keys`, `quotas`, `usage_logs`, dan `treasury_snapshots` dengan fallback anggun (*graceful fallback*) ke Redis.
   - Pencatatan log metadata inferensi tanpa pernah menyimpan teks prompt/completion (batasan privasi mutlak).
7. **Keamanan & Guarding**:
   - Proteksi CSRF (`Origin` & `Referer` validation) pada seluruh rute mutasi auth dan kunci API.
   - Token bucket rate limiter berbasis Redis pada endpoint sensitif (SIWE nonce/verify dan inference gateway).
   - Global Protocol Budget Guard (`/v1/budget/status`) yang mengawasi total pengeluaran harian dan memblokir overspending di atas 100% yield epoch.

## Menjalankan Backend

```bash
bun run dev:backend       # Development mode (port 3001)
bun run build:backend     # Production build
bun test backend/test     # Menjalankan 65 unit, integration, reconciliation, load, dan chaos test backend
```
