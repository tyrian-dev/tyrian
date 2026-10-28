/* Tyrian shared runtime: config, theme, menu, toasts, wallet sign-in, transactions, dialogs,
   model catalog, charts and motion. Every page loads this file; page scripts use window.Tyr. */
(() => {
  const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(hover:hover) and (pointer:fine)').matches;
  if (window.gsap && window.ScrollTrigger) gsap.registerPlugin(ScrollTrigger);

  /* ---------- config: edit here before launch ---------- */
  const CONFIG = Object.assign({
    site: 'https://tyrian.app',
    // Testnet per the brief (.env NEXT_PUBLIC_CHAIN_ID=46630). Mainnet: id 4663, hex 0x1237.
    chain: { id: 46630, hex: '0xb626', name: 'Robinhood Chain Testnet',
      rpc: 'https://rpc.testnet.chain.robinhood.com/rpc', explorer: 'https://explorer.testnet.chain.robinhood.com' },
    stakeManager: '0x0000000000000000000000000000000000000000',
    tokens: {
      USDG: '0x0000000000000000000000000000000000000001',
      TYR: '0x0000000000000000000000000000000000000002',
      AAPL: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
      NVDA: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
      MSFT: '0xe93237C50D904957Cf27E7B1133b510C669c2e74',
      GOOGL: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3',
      AMZN: '0x12f190a9F9d7D37a250758b26824B97CE941bF54',
      META: '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35',
      TSLA: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d',
      AMD: '0x86923f96303D656E4aa86D9d42D1e57ad2023fdC',
    },
    gateway: '/v1', // Proxied directly to Hono AI Gateway
    modelAllowlist: ['openai/', 'anthropic/', 'google/', 'meta-llama/', 'qwen/', 'deepseek/'],
    cooldownDays: 7, utilization: 0.9, stockPoolShare: 0.4, maxBoost: 1.5
  }, window.TYR_CONFIG || {});

  /* ---------- small utils ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const short = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
  const fmtUSD = (n, d) => {
    const dd = d ?? (Math.abs(n) >= 1000 ? 0 : 2);
    return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dd, maximumFractionDigits: dd });
  };
  const fmtNum = (n, d = 0) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtCompact = n => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  const store = {
    get(k, def) { try { const v = localStorage.getItem('tyr-' + k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
    set(k, v) { try { localStorage.setItem('tyr-' + k, JSON.stringify(v)); } catch (e) {} }
  };
  // Deterministic sample data so preview numbers stay the same between visits.
  function rand(seed) { let s = seed >>> 0 || 1; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
  const nextEpoch = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };
  const fmtDur = ms => {
    ms = Math.max(0, ms); const d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5), m = Math.floor(ms % 36e5 / 6e4), s = Math.floor(ms % 6e4 / 1e3);
    return d > 0 ? `${d}d ${String(h).padStart(2, '0')}h` : `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  /* ---------- toast ---------- */
  const toast = $('#toast'), tt = $('#toastText');
  let toastTimer;
  function notify(tone, text, ms = 3800, link) {
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.className = 'toast show ' + tone;
    tt.textContent = text;
    if (link) { const a = document.createElement('a'); a.href = link.href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = link.label; tt.append(a); }
    if (ms) toastTimer = setTimeout(() => toast.className = 'toast ' + tone, ms);
  }
  const lockScroll = on => { try { on ? window.__lenis?.stop() : window.__lenis?.start(); } catch (e) {} document.documentElement.style.overflow = on ? 'hidden' : ''; };

  /* ---------- theme with circular curtain ---------- */
  const root = document.documentElement;
  try { const t = localStorage.getItem('tyr-theme'); if (t) root.dataset.theme = t; } catch (e) {}
  $$('.theme-toggle').forEach(btn => btn.addEventListener('click', e => {
    const next = root.dataset.theme === 'light' ? 'dark' : 'light';
    const apply = () => { root.dataset.theme = next; try { localStorage.setItem('tyr-theme', next); } catch (e) {} dispatchEvent(new Event('themechange')); };
    if (!document.startViewTransition || RM) return apply();
    const x = e.clientX || innerWidth / 2, y = e.clientY || 40, r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    document.startViewTransition(apply).ready.then(() => {
      root.animate({ clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 700, easing: 'cubic-bezier(.16,1,.3,1)', pseudoElement: '::view-transition-new(root)' });
    });
  }));

  /* ---------- active page in nav ---------- */
  const page = (location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '') || 'index';
  $$('.nav-links a, .mmenu nav a').forEach(a => {
    const target = (a.getAttribute('href') || '').split('#')[0].replace(/\.html$/, '').replace(/^\.?\//, '');
    if (target && target === page) a.setAttribute('aria-current', 'page');
  });

  /* ---------- mobile menu ---------- */
  const menuBtn = $('#menuBtn'), mmenu = $('#mmenu');
  function openMenu() {
    const r = menuBtn.getBoundingClientRect();
    mmenu.style.setProperty('--cx', (r.left + r.width / 2) + 'px'); mmenu.style.setProperty('--cy', (r.top + r.height / 2) + 'px');
    mmenu.classList.add('open'); menuBtn.setAttribute('aria-expanded', 'true'); menuBtn.setAttribute('aria-label', 'Close menu'); lockScroll(true);
  }
  function closeMenu() {
    if (!mmenu?.classList.contains('open')) return;
    mmenu.classList.remove('open'); menuBtn.setAttribute('aria-expanded', 'false'); menuBtn.setAttribute('aria-label', 'Open menu'); lockScroll(false);
  }
  if (menuBtn && mmenu) {
    menuBtn.addEventListener('click', () => mmenu.classList.contains('open') ? closeMenu() : openMenu());
    $$('nav a', mmenu).forEach(a => a.addEventListener('click', closeMenu));
    addEventListener('resize', () => { if (innerWidth > 1100) closeMenu(); });
  }

  /* ---------- errors: one short human sentence, raw details only in the console ---------- */
  function friendly(err) {
    const code = err?.code ?? err?.data?.originalError?.code ?? err?.cause?.code;
    const raw = String(err?.shortMessage || err?.message || '');
    console.debug('[tyrian]', err);
    if (code === 4001 || code === 'ACTION_REJECTED' || /user (rejected|denied)|rejected the request|cancel/i.test(raw)) return { tone: 'neutral', text: 'Request cancelled.', rejected: true };
    if (code === -32002) return { tone: 'warn', text: 'Your wallet already has a request open. Check the wallet window.' };
    if (code === 4902 || /unrecognized chain|unknown chain/i.test(raw)) return { tone: 'err', text: 'Robinhood Chain is not in your wallet yet. Try again to add it.' };
    if (/insufficient funds/i.test(raw)) return { tone: 'err', text: 'Not enough ETH to pay for gas.' };
    if (/exceeds balance|insufficient balance|transfer amount exceeds/i.test(raw)) return { tone: 'err', text: 'Your balance is too low for this amount.' };
    if (/paused/i.test(raw)) return { tone: 'warn', text: 'Deposits are paused right now. Withdrawals still work.' };
    if (/cooldown/i.test(raw)) return { tone: 'warn', text: 'This position is still in its cooldown.' };
    if (/network|fetch|timeout/i.test(raw)) return { tone: 'err', text: 'Network problem. Check your connection and try again.' };
    return { tone: 'err', text: 'Something went wrong. Please try again.' };
  }

  /* ---------- wallet: connect, network, sign in (SIWE format) ---------- */
  const CHAIN = CONFIG.chain;
  const W = { account: null, chain: null, signed: false, busy: false };
  const eth = () => window.ethereum;
  const listeners = new Set();
  const emit = () => { store.set('wallet', W.account ? { account: W.account, signed: W.signed } : null); listeners.forEach(f => { try { f(state()); } catch (e) { console.error(e); } }); };
  const state = () => ({ account: W.account, chain: W.chain, signed: W.signed, onChain: W.chain === CHAIN.hex, connected: !!W.account });
  const walletBtn = $('#walletBtn'), modal = $('#walletModal');
  const wmAction = $('#wmAction'), wmMsg = $('#wmMsg'), wmFoot = $('#wmFoot'), acctMenu = $('#acctMenu');
  const step = () => !W.account ? 1 : (W.chain !== CHAIN.hex ? 2 : (!W.signed ? 3 : 4));
  const say = (tone, text) => { if (!wmMsg) return; wmMsg.className = 'wm-msg ' + (tone || ''); wmMsg.textContent = text || ''; };
  let wantSign = true, afterConnect = null;

  function render() {
    if (modal) {
      const n = step(), total = wantSign ? 3 : 2;
      $$('.steps li', modal).forEach(li => {
        const k = +li.dataset.step;
        li.hidden = !wantSign && k === 3;
        li.className = k < n ? 'done' : (k === n ? 'active' : '');
        li.querySelector('.dot').textContent = k < n ? '✓' : k;
        if (k === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
      });
      const done = wantSign ? n === 4 : n >= 3;
      const labels = { 1: 'Connect wallet', 2: 'Switch network', 3: 'Sign message' };
      wmAction.disabled = W.busy;
      wmAction.innerHTML = W.busy ? '<span class="spin" aria-hidden="true"></span><span>Waiting for wallet…</span>' : `<span>${done ? 'Done' : labels[n]}</span>`;
      wmFoot.textContent = done ? 'All set' : `Step ${Math.min(n, total)} of ${total}`;
    }
    if (walletBtn) {
      walletBtn.classList.remove('btn-primary', 'btn-secondary', 'btn-warn');
      if (!W.account) { walletBtn.classList.add('btn-primary'); walletBtn.innerHTML = '<span class="lbl-long">Connect wallet</span><span class="lbl-short">Connect</span>'; }
      else if (W.chain !== CHAIN.hex) { walletBtn.classList.add('btn-warn'); walletBtn.innerHTML = '<span class="lbl-long">Wrong network</span><span class="lbl-short">Network</span>'; }
      else { walletBtn.classList.add('btn-secondary'); walletBtn.innerHTML = `<i class="live" aria-hidden="true"></i><span class="mono">${short(W.account)}</span>`; }
      walletBtn.setAttribute('aria-label', W.account ? `Wallet ${short(W.account)}${W.signed ? ', signed in' : ''}` : 'Connect wallet');
    }
  }

  let lastFocus = null;
  function openWallet(opts = {}) {
    wantSign = opts.sign !== false; afterConnect = opts.then || null;
    lastFocus = document.activeElement; closeAcct(); closeMenu();
    modal.hidden = false; lockScroll(true); say(); render(); wmAction.focus();
  }
  function closeWallet() { modal.hidden = true; lockScroll(false); lastFocus?.focus?.(); }
  modal && $$('[data-close]', modal).forEach(el => el.addEventListener('click', closeWallet));

  function openAcct() {
    const r = walletBtn.getBoundingClientRect();
    acctMenu.style.top = (r.bottom + 8) + 'px'; acctMenu.style.right = Math.max(16, innerWidth - r.right) + 'px';
    $('#acctWho').textContent = short(W.account) + ' · ' + (W.signed ? 'signed in' : 'not signed in');
    $('#acctExplorer').href = `${CHAIN.explorer}/address/${W.account}`;
    $('#acctSign').hidden = W.signed;
    acctMenu.hidden = false;
  }
  function closeAcct() { if (acctMenu) acctMenu.hidden = true; }
  async function disconnect(silent) {
    closeAcct();
    try { await eth()?.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }); } catch (e) { /* optional in many wallets */ }
    Object.assign(W, { account: null, chain: null, signed: false }); render(); emit();
    if (!silent) notify('neutral', 'Disconnected.');
  }

  walletBtn?.addEventListener('click', e => {
    e.stopPropagation();
    if (W.account && W.chain === CHAIN.hex) return acctMenu.hidden ? openAcct() : closeAcct();
    openWallet();
  });
  document.addEventListener('click', e => { if (acctMenu && !acctMenu.hidden && !acctMenu.contains(e.target)) closeAcct(); });
  addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (modal && !modal.hidden && !W.busy) closeWallet();
    closeAcct(); closeMenu(); closeDialog(false);
  });
  $('#acctCopy')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(W.account); notify('ok', 'Address copied.', 2000); } catch (e) { notify('neutral', W.account, 6000); }
    closeAcct();
  });
  $('#acctSign')?.addEventListener('click', () => openWallet());
  $('#acctDisconnect')?.addEventListener('click', () => disconnect());

  const toHex = str => '0x' + [...new TextEncoder().encode(str)].map(b => b.toString(16).padStart(2, '0')).join('');
  function siweMessage(addr) {
    const nonce = [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
    const host = location.host || 'tyrian.example', origin = location.origin.startsWith('http') ? location.origin : CONFIG.site;
    return `${host} wants you to sign in with your Ethereum account:\n${addr}\n\nSign in to Tyrian. This does not send a transaction or cost gas.\n\nURI: ${origin}\nVersion: 1\nChain ID: ${CHAIN.id}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
  }

  wmAction?.addEventListener('click', async () => {
    if (W.busy) return;
    const n = step();
    if ((wantSign && n === 4) || (!wantSign && n >= 3)) return closeWallet();
    if (!eth()) return say('err', 'No browser wallet found. Install one, then try again.');
    W.busy = true; say('neutral', n === 3 ? 'Check your wallet to sign the message.' : 'Check your wallet to continue.'); render();
    try {
      if (n === 1) {
        const accts = await eth().request({ method: 'eth_requestAccounts' });
        W.account = accts?.[0] || null;
        W.chain = String(await eth().request({ method: 'eth_chainId' })).toLowerCase();
        say(W.chain === CHAIN.hex ? 'ok' : 'warn', W.chain === CHAIN.hex ? 'Wallet connected.' : `Wallet connected. Switch to ${CHAIN.name} next.`);
      } else if (n === 2) {
        try { await eth().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN.hex }] }); }
        catch (err) {
          if ((err?.code ?? err?.data?.originalError?.code) !== 4902) throw err;
          await eth().request({ method: 'wallet_addEthereumChain', params: [{ chainId: CHAIN.hex, chainName: CHAIN.name,
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [CHAIN.rpc], blockExplorerUrls: [CHAIN.explorer] }] });
        }
        W.chain = String(await eth().request({ method: 'eth_chainId' })).toLowerCase();
        say('ok', 'Network switched.');
      } else if (n === 3) {
        await eth().request({ method: 'personal_sign', params: [toHex(siweMessage(W.account)), W.account] });
        W.signed = true; say('ok', 'Signed in.');
      }
      emit();
      const finished = wantSign ? step() === 4 : step() >= 3;
      if (finished) setTimeout(() => {
        if (modal.hidden) return;
        closeWallet();
        notify('ok', wantSign ? `Signed in as ${short(W.account)}` : `Connected as ${short(W.account)}`);
        const f = afterConnect; afterConnect = null; f && f(state());
      }, 700);
    } catch (err) {
      const f = friendly(err); say(f.tone, f.text);
    } finally { W.busy = false; render(); }
  });

  // Restore a previous session without prompting (eth_accounts never opens the wallet).
  async function restore() {
    const saved = store.get('wallet', null);
    if (!saved || !eth()) return;
    try {
      const accts = await eth().request({ method: 'eth_accounts' });
      const match = accts?.find(a => a.toLowerCase() === saved.account.toLowerCase());
      if (!match) { store.set('wallet', null); return; }
      W.account = match; W.signed = !!saved.signed;
      W.chain = String(await eth().request({ method: 'eth_chainId' })).toLowerCase();
      render(); emit();
    } catch (e) { console.debug('[tyrian] restore', e); }
  }
  if (eth()?.on) {
    eth().on('accountsChanged', accts => {
      if (!W.account) return;
      if (!accts?.length) { Object.assign(W, { account: null, chain: null, signed: false }); notify('neutral', 'Wallet disconnected.'); }
      else if (accts[0].toLowerCase() !== W.account.toLowerCase()) { W.account = accts[0]; W.signed = false; notify('warn', 'Account changed. Sign in again to continue.'); }
      render(); emit();
    });
    eth().on('chainChanged', id => {
      if (!W.account) return;
      W.chain = String(id).toLowerCase(); render(); emit();
      if (W.chain !== CHAIN.hex) notify('warn', `Switch back to ${CHAIN.name} to keep using Tyrian.`);
    });
  }
  $$('[data-open-wallet]').forEach(b => b.addEventListener('click', () => openWallet()));
  render(); restore();

  /* ---------- on-chain helpers (used once contracts are deployed) ---------- */
  const SEL = { approve: '0x095ea7b3', allowance: '0xdd62ed3e', balanceOf: '0x70a08231', stake: '0xadc9772e',
    requestUnstake: '0x710ba631', withdraw: '0x51cff8d9', latestRoundData: '0xfeaf968c', decimals: '0x313ce567' };
  const word = v => (typeof v === 'string' ? v.replace(/^0x/, '').toLowerCase() : BigInt(v).toString(16)).padStart(64, '0');
  const encode = (sel, ...args) => sel + args.map(word).join('');
  function toUnits(str, decimals = 18) {
    const [i, f = ''] = String(str).trim().split('.');
    return BigInt(i || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
  }
  const call = (to, data) => eth().request({ method: 'eth_call', params: [{ to, data }, 'latest'] });
  async function sendTx(to, data) {
    const hash = await eth().request({ method: 'eth_sendTransaction', params: [{ from: W.account, to, data }] });
    for (let i = 0; i < 120; i++) {
      const rc = await eth().request({ method: 'eth_getTransactionReceipt', params: [hash] });
      if (rc) { if (rc.status === '0x0') throw new Error('Transaction reverted'); return { hash, receipt: rc }; }
      await new Promise(r => setTimeout(r, 1500));
    }
    throw new Error('timeout waiting for receipt');
  }
  const txLink = hash => ({ href: `${CHAIN.explorer}/tx/${hash}`, label: 'View on Blockscout' });

  /* ---------- confirm dialog (replaces window.confirm) ---------- */
  const dlg = $('#confirmModal');
  let dlgResolve = null;
  function confirmDialog({ title, body, confirm = 'Confirm', tone = 'primary', cancel = 'Cancel' }) {
    $('#cfTitle').textContent = title; $('#cfBody').textContent = body;
    const ok = $('#cfOk'); ok.textContent = confirm; ok.className = 'btn ' + (tone === 'danger' ? 'btn-danger-solid' : 'btn-primary');
    $('#cfCancel').textContent = cancel;
    dlg.hidden = false; lockScroll(true); $('#cfCancel').focus();
    return new Promise(res => dlgResolve = res);
  }
  function closeDialog(v) { if (!dlg || dlg.hidden) return; dlg.hidden = true; lockScroll(false); dlgResolve?.(v); dlgResolve = null; }
  if (dlg) {
    $('#cfOk').addEventListener('click', () => closeDialog(true));
    $('#cfCancel').addEventListener('click', () => closeDialog(false));
    $$('[data-close]', dlg).forEach(el => el.addEventListener('click', () => closeDialog(false)));
  }

  /* ---------- copy buttons ---------- */
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-copy]'); if (!b) return;
    const src = b.dataset.copy.startsWith('#') ? $(b.dataset.copy)?.textContent : b.dataset.copy;
    try { await navigator.clipboard.writeText(src || ''); const old = b.textContent; b.textContent = 'Copied'; setTimeout(() => b.textContent = old, 1400); }
    catch (err) { notify('neutral', 'Copy is blocked in this browser. Select the text instead.'); }
  });

  /* ---------- model catalog (OpenRouter public list, filtered by MODEL_ALLOWLIST) ---------- */
  let modelsPromise = null;
  function loadModels(force) {
    if (modelsPromise && !force) return modelsPromise;
    if (!force) { try { const c = JSON.parse(sessionStorage.getItem('tyr-models') || 'null'); if (c && Date.now() - c.t < 36e5) return modelsPromise = Promise.resolve(c.list); } catch (e) {} }
    modelsPromise = fetch('https://openrouter.ai/api/v1/models', { headers: { Accept: 'application/json' } })
      .then(r => { if (!r.ok) throw new Error('models ' + r.status); return r.json(); })
      .then(j => {
        const list = (j.data || [])
          .filter(m => CONFIG.modelAllowlist.some(p => m.id.startsWith(p)))
          .filter(m => !m.architecture || (m.architecture.output_modalities || ['text']).includes('text'))
          .filter(m => +m.pricing?.prompt >= 0 && +m.pricing?.completion >= 0)
          .map(m => ({ id: m.id, name: (m.name || m.id).replace(/^[^:]+:\s*/, ''), provider: m.id.split('/')[0],
            ctx: m.context_length || m.top_provider?.context_length || 0,
            inM: +m.pricing.prompt * 1e6, outM: +m.pricing.completion * 1e6, created: m.created || 0,
            maxOut: m.top_provider?.max_completion_tokens || null }));
        try { sessionStorage.setItem('tyr-models', JSON.stringify({ t: Date.now(), list })); } catch (e) {}
        return list;
      })
      .catch(e => { modelsPromise = null; throw e; });
    return modelsPromise;
  }
  const providerName = p => ({ openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', 'meta-llama': 'Meta Llama', qwen: 'Qwen', deepseek: 'DeepSeek' }[p] || p);

  /* ---------- charts (single y-axis, hover tooltip, table view) ---------- */
  const NS = 'http://www.w3.org/2000/svg';
  function niceMax(v) { if (!(v > 0)) return 1; const p = Math.pow(10, Math.floor(Math.log10(v || 1))); return Math.ceil(v / p / (v / p > 5 ? 2 : 1)) * p * (v / p > 5 ? 2 : 1); }
  function chart(el, { labels, series, type = 'bar', format = v => fmtUSD(v), height = 240, tableCaption = '' }) {
    el.classList.add('chart');
    if (!series.some(s => s.values.some(v => v > 0))) { el.innerHTML = `<div class="empty" style="padding:48px 16px"><h3>No usage yet</h3><p>Daily cost shows up here once you start sending requests.</p></div>`; return; }
    const W0 = 720, H = height, padL = 54, padR = 12, padT = 12, padB = 30, iw = W0 - padL - padR, ih = H - padT - padB;
    const max = niceMax(Math.max(...series.flatMap(s => s.values)) * 1.08);
    const x = i => padL + (type === 'bar' ? (i + .5) * iw / labels.length : i * iw / (labels.length - 1));
    const y = v => padT + ih - v / max * ih;
    let svg = `<svg viewBox="0 0 ${W0} ${H}" role="img" aria-label="${esc(tableCaption)}"><g class="axis">`;
    for (let k = 0; k <= 4; k++) { const v = max * k / 4, yy = y(v); svg += `<line class="${k ? 'gridline' : 'baseline'}" x1="${padL}" x2="${W0 - padR}" y1="${yy}" y2="${yy}"/><text x="${padL - 8}" y="${yy + 4}" text-anchor="end">${esc(fmtCompactUSD(v))}</text>`; }
    labels.forEach((l, i) => { if (i % Math.ceil(labels.length / 6) === 0 || i === labels.length - 1) svg += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(l)}</text>`; });
    svg += '</g>';
    if (type === 'bar') {
      const bw = Math.max(3, iw / labels.length - 3);
      series[0].values.forEach((v, i) => {
        const h = Math.max(1, y(0) - y(v)), x0 = x(i) - bw / 2, r = Math.min(4, bw / 2, h);
        svg += `<path d="M${x0},${y(0)} V${y(v) + r} Q${x0},${y(v)} ${x0 + r},${y(v)} H${x0 + bw - r} Q${x0 + bw},${y(v)} ${x0 + bw},${y(v) + r} V${y(0)} Z" style="fill:${series[0].color}" class="bar" data-i="${i}"/>`;
      });
    } else {
      series.forEach(s => { svg += `<path d="${s.values.map((v, i) => (i ? 'L' : 'M') + x(i) + ',' + y(v)).join(' ')}" fill="none" style="stroke:${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" ${s.dash ? 'stroke-dasharray="5 4"' : ''}/>`; });
      svg += `<line class="xh" x1="0" x2="0" y1="${padT}" y2="${padT + ih}" style="stroke:var(--border-strong)" stroke-width="1" opacity="0"/>`;
      series.forEach((s, k) => svg += `<circle class="dot dot${k}" r="4.5" style="fill:${s.color};stroke:var(--surface)" stroke-width="2" opacity="0"/>`);
    }
    svg += `<rect class="hit" x="${padL}" y="${padT}" width="${iw}" height="${ih}" fill="transparent"/></svg>`;
    const rows = labels.map((l, i) => `<tr><td>${esc(l)}</td>${series.map(s => `<td class="num">${esc(format(s.values[i]))}</td>`).join('')}</tr>`).join('');
    el.innerHTML = svg + '<div class="chart-tip" role="presentation"></div>' +
      `<details class="chart-table" style="margin-top:10px"><summary class="btn btn-ghost btn-sm" style="display:inline-flex;list-style:none">View as table</summary>
       <div class="table-wrap" style="margin-top:10px;max-height:300px;overflow:auto"><table class="data"><caption class="sr-only">${esc(tableCaption)}</caption>
       <thead><tr><th>Day</th>${series.map(s => `<th class="num">${esc(s.name)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div></details>`;
    const s = el.querySelector('svg'), tip = el.querySelector('.chart-tip'), hit = s.querySelector('.hit');
    function show(i) {
      const box = s.getBoundingClientRect(), k = box.width / W0;
      if (type === 'bar') s.querySelectorAll('.bar').forEach(b => b.style.opacity = +b.dataset.i === i ? 1 : .45);
      else {
        s.querySelector('.xh').setAttribute('x1', x(i)); s.querySelector('.xh').setAttribute('x2', x(i)); s.querySelector('.xh').setAttribute('opacity', 1);
        series.forEach((ser, j) => { const c = s.querySelector('.dot' + j); c.setAttribute('cx', x(i)); c.setAttribute('cy', y(ser.values[i])); c.setAttribute('opacity', 1); });
      }
      tip.innerHTML = `<div class="t">${esc(labels[i])}</div>` + series.map(ser => `<div class="r"><span><i style="width:10px;height:3px;border-radius:2px;background:${ser.color};display:inline-block"></i>${esc(ser.name)}</span><b>${esc(format(ser.values[i]))}</b></div>`).join('');
      tip.classList.add('on');
      const tx = x(i) * k, maxL = box.width - tip.offsetWidth - 4;
      tip.style.left = Math.max(4, Math.min(maxL, tx + 12)) + 'px'; tip.style.top = Math.max(0, y(Math.max(...series.map(q => q.values[i]))) * k - tip.offsetHeight - 10) + 'px';
    }
    function hide() { tip.classList.remove('on'); s.querySelectorAll('.bar').forEach(b => b.style.opacity = 1); s.querySelectorAll('.dot,.xh').forEach(d => d.setAttribute('opacity', 0)); }
    const idx = e => { const box = s.getBoundingClientRect(), px = (e.clientX - box.left) / box.width * W0;
      return Math.max(0, Math.min(labels.length - 1, type === 'bar' ? Math.floor((px - padL) / (iw / labels.length)) : Math.round((px - padL) / (iw / (labels.length - 1))))); };
    hit.addEventListener('pointermove', e => show(idx(e)));
    hit.addEventListener('pointerleave', hide);
  }
  const fmtCompactUSD = v => '$' + (v >= 1000 ? fmtCompact(v) : (v % 1 ? v.toFixed(v < 10 ? 2 : 0) : v));

  /* ---------- odometer ---------- */
  function odo(el, text) {
    el.classList.add('odo'); el.setAttribute('aria-label', text);
    el.innerHTML = [...text].map(ch => /\d/.test(ch)
      ? `<span class="col" aria-hidden="true" data-d="${ch}"><span>${'01234567890123456789'.split('').map(n => `<i>${n}</i>`).join('')}</span></span>`
      : `<span aria-hidden="true">${ch === ' ' ? '&nbsp;' : esc(ch)}</span>`).join('');
    const cols = $$('.col', el);
    if (RM || typeof gsap === 'undefined') { cols.forEach(c => c.firstElementChild.style.transform = `translateY(-${c.dataset.d * 1.1}em)`); return; }
    const run = () => cols.forEach((c, i) => gsap.fromTo(c.firstElementChild, { y: 0 }, { y: `-${(+c.dataset.d + 10) * 1.1}em`, duration: 1.4 + i * .08, ease: 'expo.out', delay: i * .03 }));
    if (typeof ScrollTrigger !== 'undefined') ScrollTrigger.create({ trigger: el, start: 'top 92%', once: true, onEnter: run }); else run();
  }

  /* ---------- motion for inner pages ---------- */
  function motion() {
    const hasG = typeof gsap !== 'undefined';
    const nav = $('#nav');
    const onScroll = () => nav?.classList.toggle('scrolled', scrollY > 30);
    addEventListener('scroll', onScroll, { passive: true }); onScroll();
    if (RM || !hasG) return;
    gsap.registerPlugin(ScrollTrigger);
    if (typeof Lenis !== 'undefined') {
      const lenis = new Lenis({ lerp: .1, smoothWheel: true }); window.__lenis = lenis;
      lenis.on('scroll', ScrollTrigger.update);
      gsap.ticker.add(t => lenis.raf(t * 1000)); gsap.ticker.lagSmoothing(0);
      $$('a[href^="#"]').forEach(a => a.addEventListener('click', e => {
        const t = $(a.getAttribute('href')); if (!t) return; e.preventDefault(); closeMenu(); lenis.scrollTo(t, { offset: -90, duration: 1.2 });
      }));
    }
    // page title: per-word mask rise
    $$('.page-head h1').forEach(h => {
      h.setAttribute('aria-label', h.textContent);
      h.innerHTML = h.textContent.split(' ').map(w => `<span aria-hidden="true" style="display:inline-block;overflow:hidden;vertical-align:top;padding-bottom:.08em"><span class="w" style="display:inline-block">${esc(w)}</span></span>`).join(' ');
      gsap.from(h.querySelectorAll('.w'), { yPercent: 110, duration: .8, ease: 'power3.out', stagger: .05, delay: .1 });
    });
    gsap.from('.page-head .eyebrow, .page-head .lead, .page-head .aside', { y: 18, opacity: 0, duration: .7, ease: 'power3.out', stagger: .06, delay: .2 });
    $$('[data-reveal]').forEach(el => gsap.from(el, { y: 26, opacity: 0, duration: .7, ease: 'power3.out', scrollTrigger: { trigger: el, start: 'top 92%' } }));
    if (!fine) return;
    const ring = $('.cursor'), dot = $('.cursor-dot');
    if (ring && dot) {
      const rx = gsap.quickTo(ring, 'x', { duration: .45, ease: 'power3.out' }), ry = gsap.quickTo(ring, 'y', { duration: .45, ease: 'power3.out' });
      const dx = gsap.quickTo(dot, 'x', { duration: .08 }), dy = gsap.quickTo(dot, 'y', { duration: .08 });
      addEventListener('mousemove', e => { ring.classList.add('on'); dot.classList.add('on'); rx(e.clientX); ry(e.clientY); dx(e.clientX); dy(e.clientY); });
      document.addEventListener('mouseover', e => ring.classList.toggle('is-link', !!e.target.closest('a,button,select,input,textarea,summary,[role=tab]')));
    }
    $$('.magnetic').forEach(el => {
      const xTo = gsap.quickTo(el, 'x', { duration: .4, ease: 'power3.out' }), yTo = gsap.quickTo(el, 'y', { duration: .4, ease: 'power3.out' });
      el.addEventListener('mousemove', e => { const r = el.getBoundingClientRect(); xTo((e.clientX - r.left - r.width / 2) * .3); yTo((e.clientY - r.top - r.height / 2) * .4); });
      el.addEventListener('mouseleave', () => gsap.to(el, { x: 0, y: 0, duration: .8, ease: 'elastic.out(1,.35)' }));
    });
    tilt();
  }
  function tilt(scope = document) {
    if (RM || !fine || typeof gsap === 'undefined') return;
    $$('.tilt', scope).forEach(wrap => {
      if (wrap.dataset.tiltOn) return; wrap.dataset.tiltOn = 1;
      const card = wrap.firstElementChild;
      const rX = gsap.quickTo(card, 'rotationX', { duration: .5, ease: 'power3.out' }), rY = gsap.quickTo(card, 'rotationY', { duration: .5, ease: 'power3.out' });
      wrap.addEventListener('mousemove', e => {
        if (e.target.closest('input,button,select')) return;
        const r = card.getBoundingClientRect(), px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
        rY((px - .5) * 8); rX((.5 - py) * 7); card.style.setProperty('--mx', px * 100 + '%'); card.style.setProperty('--my', py * 100 + '%');
      });
      wrap.addEventListener('mouseleave', () => { rX(0); rY(0); });
    });
  }

  /* ---------- assets, preview figures and the quota formula from the brief ---------- */
  const ASSETS = [
    { sym: 'USDG', name: 'Global Dollar', kind: 'base', pool: 'USDG pool', dec: 18 },
    { sym: 'TYR', name: 'Tyrian', kind: 'boost', pool: '$TYR pool', dec: 18 },
    { sym: 'AAPL', name: 'Apple', kind: 'stock', addr: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', feed: '0x6B22A786bAa607d76728168703a39Ea9C99f2cD0' },
    { sym: 'NVDA', name: 'NVIDIA', kind: 'stock', addr: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', feed: '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15' },
    { sym: 'MSFT', name: 'Microsoft', kind: 'stock', addr: '0xe93237C50D904957Cf27E7B1133b510C669c2e74', feed: '0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E' },
    { sym: 'GOOGL', name: 'Alphabet', kind: 'stock', addr: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3', feed: '0xF6f373a037c30F0e5010d854385cA89185AE638b' },
    { sym: 'AMZN', name: 'Amazon', kind: 'stock', addr: '0x12f190a9F9d7D37a250758b26824B97CE941bF54', feed: '0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C' },
    { sym: 'META', name: 'Meta', kind: 'stock', addr: '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35', feed: '0x7C38C00C30BEe9378381E7B6135d7283356D71b1' },
    { sym: 'TSLA', name: 'Tesla', kind: 'stock', addr: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', feed: '0x4A1166a659A55625345e9515b32adECea5547C38' },
    { sym: 'AMD', name: 'AMD', kind: 'stock', addr: '0x86923f96303D656E4aa86D9d42D1e57ad2023fdC', feed: '0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72' }
  ].map(a => ({ pool: 'Stock pool', dec: 18, ...a }));
  // Preview-only numbers. Replace with indexer + Chainlink data at launch. Every page that shows them says so.
  const PREVIEW = {
    prices: { USDG: 1, TYR: 0.0004, AAPL: 255, NVDA: 185, MSFT: 520, GOOGL: 250, AMZN: 225, META: 715, TSLA: 440, AMD: 230 },
    // Budgets follow the brief's own example: USDG pool harvested $300 → B = $270 (1,000 of 100,000 USDG → $2.70/day).
    // `total` is everyone else's weight in the pool. Daily budget split 40/60 stock/$TYR.
    pools: { usdg: { B: 270, total: 99000 }, stock: { B: 141.12, total: 2000000 }, tyr: { B: 211.68, total: 50000000 } },
    balances: { USDG: 5000, TYR: 2000000, stock: 12 }
  };
  const price = sym => PREVIEW.prices[sym] ?? 0;
  function quota(positions) {
    const live = (positions || []).filter(p => p.status === 'active' && p.activeFrom <= Date.now());
    let usdgV = 0, stockV = 0, tyr = 0;
    live.forEach(p => { const a = ASSETS.find(x => x.sym === p.asset); if (!a) return;
      if (a.kind === 'base') usdgV += p.amount * price(a.sym); else if (a.kind === 'stock') stockV += p.amount * price(a.sym); else tyr += p.amount; });
    const base = usdgV + stockV, tyrV = tyr * price('TYR');
    const boost = base > 0 ? 1 + 0.5 * Math.min(1, tyrV / base) : 1;
    const P = PREVIEW.pools, wU = usdgV * boost, wS = stockV * boost;
    const pools = [
      { name: 'USDG pool', weight: wU, share: wU ? wU / (P.usdg.total + wU) : 0, B: P.usdg.B },
      { name: 'Stock pool', weight: wS, share: wS ? wS / (P.stock.total + wS) : 0, B: P.stock.B },
      { name: '$TYR pool', weight: tyr, share: tyr ? tyr / (P.tyr.total + tyr) : 0, B: P.tyr.B, unit: 'TYR' }
    ].map(p => ({ ...p, q: p.B * p.share }));
    return { usdgV, stockV, tyr, tyrV, base, boost, pools, total: pools.reduce((s, p) => s + p.q, 0) };
  }
  const positions = {
    get: acct => acct ? store.get('pos-' + acct.toLowerCase(), []) : [],
    set: (acct, list) => acct && store.set('pos-' + acct.toLowerCase(), list)
  };

  window.Tyr = { ASSETS, PREVIEW, price, quota, positions, CONFIG, RM, fine, $, $$, esc, short, fmtUSD, fmtNum, fmtCompact, fmtDur, nextEpoch, store, rand,
    notify, friendly, lockScroll, closeMenu, openWallet, closeWallet, disconnect, onWallet: f => { listeners.add(f); f(state()); }, wallet: state,
    eth, SEL, encode, toUnits, call, sendTx, txLink, confirm: confirmDialog, loadModels, providerName, chart, odo, motion, tilt };
})();
