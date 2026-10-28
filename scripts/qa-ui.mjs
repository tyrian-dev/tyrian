/**
 * Tyrian UI QA harness.
 *
 * Captures deterministic screenshots (reduced motion), a responsive overflow
 * matrix, console output, and interaction flows over CDP. The onboarding flow
 * injects a QA-only EIP-6963 provider so the Tyrian modal can be exercised
 * without a real wallet; production code never includes that provider.
 *
 * Usage:
 *   node scripts/qa-ui.mjs --out docs/qa/2026-10-23
 *   node scripts/qa-ui.mjs --out docs/qa/2026-10-23 --screens --matrix --console --flows
 *   node scripts/qa-ui.mjs --out docs/qa/2026-10-23 --no-template
 *
 * Requires a running frontend (default http://localhost:3000) and Chrome with
 * --remote-debugging-port=9222. The template is served from tyrian-site/ on
 * port 3002 unless --no-template is passed.
 */
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const BASE = value("--base", "http://localhost:3000").replace(/\/$/, "");
const CDP = value("--cdp", "http://127.0.0.1:9222");
const OUT = path.resolve(ROOT, value("--out", "docs/qa/latest"));
const TEMPLATE_PORT = Number(value("--template-port", "3002"));
const USE_TEMPLATE = !has("--no-template");
const MODE_FLAGS = ["--screens", "--matrix", "--console", "--flows"];
const HAS_MODE = args.some((arg) => MODE_FLAGS.includes(arg));
const DO_SCREENS = has("--screens") || !HAS_MODE;
const DO_MATRIX = has("--matrix") || !HAS_MODE;
const DO_CONSOLE = has("--console") || !HAS_MODE;
const DO_FLOWS = has("--flows") || !HAS_MODE;
const THEMES = ["dark", "light"];
const SCREEN_WIDTHS = [1440, 1024, 768, 390];
const MATRIX_WIDTHS = [320, 360, 390, 430, 480, 520, 521, 560, 720, 721, 768, 1024, 1440];

const FRONTEND_ROUTES = [
  ["home", "/"],
  ["stake", "/stake"],
  ["dashboard", "/dashboard"],
  ["playground", "/playground"],
  ["models", "/models"],
  ["treasury", "/treasury"],
  ["docs", "/docs"],
  ["notFound", "/definitely-not-a-route"],
];

const TEMPLATE_ROUTES = [
  ["home", "/index.html"],
  ["stake", "/stake.html"],
  ["dashboard", "/dashboard.html"],
  ["playground", "/playground.html"],
  ["models", "/models.html"],
  ["treasury", "/treasury.html"],
  ["docs", "/docs.html"],
  ["notFound", "/404.html"],
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function startTemplateServer() {
  const root = path.join(ROOT, "tyrian-site");
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const requested = decodeURIComponent(url.pathname);
      const relative = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
      const file = path.resolve(root, relative);
      if (!file.startsWith(root)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }
      const body = await fs.readFile(file);
      response.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(TEMPLATE_PORT, "127.0.0.1", () => resolve(server));
  });
}

async function connectCdp() {
  const targets = await (await fetch(`${CDP}/json/list`)).json();
  const target = targets.find((item) => item.type === "page");
  if (!target) throw new Error(`No page target on ${CDP}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  let nextId = 0;
  let events = [];
  const pending = new Map();

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) {
      events.push(message);
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });

  const send = (method, params = {}, timeout = 25000) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression, awaitPromise = false) => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Network.enable");

  return {
    send,
    evaluate,
    clearEvents: () => {
      events = [];
    },
    takeEvents: () => {
      const taken = events;
      events = [];
      return taken;
    },
    close: () => ws.close(),
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForReady(cdp, timeout = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    await wait(200);
    try {
      const state = await cdp.evaluate("document.readyState");
      if (state === "complete") return;
    } catch {
      // Navigation replaces the execution context; retry until the new one is ready.
    }
  }
}

async function setViewport(cdp, width, height, reducedMotion = true, mobile = width < 600) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
  await cdp.send("Emulation.setEmulatedMedia", {
    features: reducedMotion ? [{ name: "prefers-reduced-motion", value: "reduce" }] : [],
  });
}

async function navigate(cdp, url, reducedMotion = true) {
  await cdp.send("Emulation.setEmulatedMedia", {
    features: reducedMotion ? [{ name: "prefers-reduced-motion", value: "reduce" }] : [],
  });
  await cdp.send("Page.navigate", { url });
  await waitForReady(cdp);
  await cdp.evaluate("document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true", true).catch(() => {});
  await wait(500);
}

async function primeTheme(cdp, base, theme) {
  await cdp.send("Page.navigate", { url: `${base}/` });
  await waitForReady(cdp);
  await cdp.evaluate(`localStorage.setItem("tyr-theme", ${JSON.stringify(theme)}); "ok"`);
}

async function metrics(cdp) {
  return cdp.evaluate(`(() => {
    const de = document.documentElement;
    const h1 = document.querySelector("h1");
    const scrollLeft = de.scrollLeft;
    de.scrollLeft = 9999;
    const maxScrollLeft = de.scrollLeft;
    de.scrollLeft = scrollLeft;
    return {
      path: location.pathname,
      theme: de.dataset.theme ?? null,
      overflow: de.scrollWidth - de.clientWidth,
      maxScrollLeft,
      bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
      scrollWidth: de.scrollWidth,
      clientWidth: de.clientWidth,
      scrollHeight: de.scrollHeight,
      mainCount: document.querySelectorAll("main").length,
      h1: h1 ? h1.textContent.trim().slice(0, 80) : "",
      title: document.title,
    };
  })()`);
}

async function capture(cdp, file, fullPage = false) {
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: fullPage,
  });
  await sharp(Buffer.from(shot.data, "base64"))
    .webp({ quality: 72, effort: 4 })
    .toFile(file);
}

function consoleEntries(events) {
  return events
    .filter(
      (event) =>
        event.method === "Runtime.exceptionThrown" ||
        (event.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(event.params.type)) ||
        (event.method === "Log.entryAdded" && ["error", "warning"].includes(event.params.entry.level)),
    )
    .map((event) => {
      if (event.method === "Runtime.exceptionThrown") {
        return { kind: "exception", text: event.params.exceptionDetails?.text ?? "exception" };
      }
      if (event.method === "Log.entryAdded") {
        return {
          kind: "log",
          level: event.params.entry.level,
          url: event.params.entry.url ?? "",
          text: event.params.entry.text ?? "",
        };
      }
      return {
        kind: "console",
        level: event.params.type,
        text: (event.params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type).join(" "),
      };
    });
}

async function shootSuite(cdp, { name, base, routes, outDir }) {
  const results = [];
  await fs.mkdir(outDir, { recursive: true });
  for (const theme of THEMES) {
    await primeTheme(cdp, base, theme);
    for (const [route, routePath] of routes) {
      for (const width of SCREEN_WIDTHS) {
        const height = width <= 560 ? 844 : 1000;
        await setViewport(cdp, width, height, true);
        await navigate(cdp, `${base}${routePath}`, true);
        const data = await metrics(cdp);
        const file = path.join(outDir, `${route}-${width}-${theme}.webp`);
        await capture(cdp, file);
        results.push({ suite: name, route, width, height, theme, file: path.relative(ROOT, file), ...data });
        console.log(`shot ${name} ${route} ${width} ${theme} overflow=${data.overflow}`);
      }
    }
  }
  return results;
}

async function matrixSuite(cdp) {
  const results = [];
  await setViewport(cdp, 1440, 1000, false, false);
  await primeTheme(cdp, BASE, "dark");
  for (const [route, routePath] of FRONTEND_ROUTES) {
    const entry = { route, widths: {} };
    for (const width of MATRIX_WIDTHS) {
      // Desktop responsive mode: no overlay scrollbar, so scrollWidth is a
      // truthful measure of horizontal content overflow.
      await setViewport(cdp, width, width <= 560 ? 844 : 1000, false, false);
      await navigate(cdp, `${BASE}${routePath}`, false);
      const data = await metrics(cdp);
      entry.widths[width] = data;
      if (data.overflow !== 0 || data.bodyOverflow !== 0 || data.maxScrollLeft > 0) {
        console.log(
          `matrix ${route} ${width} overflow=${data.overflow}/${data.bodyOverflow} maxScrollLeft=${data.maxScrollLeft}`,
        );
      }
    }
    results.push(entry);
  }
  return results;
}

async function consoleSuite(cdp) {
  const report = {};
  await setViewport(cdp, 1440, 1000, false);
  await primeTheme(cdp, BASE, "dark");
  for (const [route, routePath] of FRONTEND_ROUTES) {
    cdp.clearEvents();
    await navigate(cdp, `${BASE}${routePath}`, false);
    await wait(900);
    report[route] = consoleEntries(cdp.takeEvents());
    console.log(`console ${route} entries=${report[route].length}`);
  }
  return report;
}

async function flowSuite(cdp) {
  const flows = {};

  await setViewport(cdp, 1440, 1000, false);
  await navigate(cdp, "about:blank", false);
  await cdp.send("Storage.clearDataForOrigin", {
    origin: BASE,
    storageTypes: "all",
  });
  await primeTheme(cdp, BASE, "light");
  await navigate(cdp, `${BASE}/playground`, false);
  await cdp.send("Network.setBlockedURLs", { urls: ["*v1/chat/completions*"] });
  await cdp.evaluate(`document.querySelector(".sugg button")?.click(); "clicked"`);
  await wait(1600);
  flows.playgroundError = await cdp.evaluate(`(() => {
    const err = document.querySelector(".msg.err");
    const legacy = document.querySelector(".msg.error");
    const style = err ? getComputedStyle(err) : null;
    return {
      errCount: document.querySelectorAll(".msg.err").length,
      legacyCount: document.querySelectorAll(".msg.error").length,
      text: err ? err.textContent.trim() : null,
      borderColor: style ? style.borderTopColor : null,
      backgroundColor: style ? style.backgroundColor : null,
    };
  })()`);
  await cdp.send("Network.setBlockedURLs", { urls: [] });

  await setViewport(cdp, 1440, 1000, false);
  await navigate(cdp, `${BASE}/`, false);
  flows.homeAnchor = await cdp.evaluate(`(async () => {
    const link = document.createElement("a");
    link.href = "#how";
    link.id = "qa-anchor";
    link.textContent = "qa";
    document.body.appendChild(link);
    link.click();
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const target = document.querySelector("#how");
    return {
      targetTop: target ? Math.round(target.getBoundingClientRect().top) : null,
      scrollY: Math.round(window.scrollY),
      expectedNoOffset: target ? Math.abs(target.getBoundingClientRect().top) <= 2 : false,
    };
  })()`, true);
  await cdp.evaluate(`document.querySelector("#qa-anchor")?.remove(); "ok"`);

  await navigate(cdp, `${BASE}/docs`, false);
  flows.docsToc = await cdp.evaluate(`(async () => {
    const buttons = [...document.querySelectorAll("#toc a, #toc button")];
    buttons[0]?.click();
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const target = document.querySelector("#overview");
    return {
      targetTop: target ? Math.round(target.getBoundingClientRect().top) : null,
      hasLenis: Boolean(window.__lenis),
    };
  })()`, true);

  // The Tyrian modal appears after a wallet connects. With no wallet in this
  // harness, verify that every connect CTA reaches the RainbowKit connector
  // layer and that its shell stays inside 320/390 px viewports.
  await setViewport(cdp, 1440, 1000, false);
  await navigate(cdp, `${BASE}/`, false);
  await cdp.evaluate('document.querySelector("#walletBtn")?.click(); "clicked"');
  await wait(900);
  const modalSnapshot = async () =>
    cdp.evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"][data-rk]');
      const close = dialog?.querySelector('button[aria-label="Close"]');
      return {
        present: Boolean(dialog),
        title: dialog?.querySelector("[data-testid='rk-connect-header-label']")?.textContent?.trim() ?? null,
        text: dialog?.textContent?.trim().slice(0, 120) ?? null,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
        dialogOverflow: dialog ? dialog.scrollWidth - dialog.clientWidth : null,
        closeVisible: Boolean(close),
      };
    })()`);

  const desktop = await modalSnapshot();
  await setViewport(cdp, 320, 844, false, true);
  await wait(350);
  const at320 = await modalSnapshot();
  await setViewport(cdp, 390, 844, false, true);
  await wait(350);
  const at390 = await modalSnapshot();
  await cdp.evaluate(
    `document.querySelector('[role="dialog"][data-rk] button[aria-label="Close"]')?.click(); "closed"`,
  );
  await wait(450);
  const closed = await cdp.evaluate(
    `!document.querySelector('[role="dialog"][data-rk]')`,
  );
  flows.walletConnectLaunch = { desktop, at320, at390, closed };
  await setViewport(cdp, 1440, 1000, false);

  // Deterministic wallet for the Tyrian modal. This is injected by the QA
  // harness only; production never ships a mock connector.
  await cdp.send("Storage.clearDataForOrigin", {
    origin: BASE,
    storageTypes: "all",
  });
  const { identifier: qaProvider } = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const address = "0x2222222222222222222222222222222222222222";
      let chainId = localStorage.getItem("qa-chain") || "0xb626";
      let chainAdded = false;
      const switchMode = () => localStorage.getItem("qa-switch-mode") || "ok";
      const listeners = new Map();
      const emit = (event, value) => {
        for (const listener of listeners.get(event) ?? []) listener(value);
      };
      const provider = {
        selectedAddress: address,
        get chainId() {
          return chainId;
        },
        request: async ({ method, params }) => {
          if (method === "eth_requestAccounts" || method === "eth_accounts") return [address];
          if (method === "eth_chainId") return chainId;
          if (method === "net_version") return String(parseInt(chainId, 16));
          if (method === "wallet_switchEthereumChain") {
            const next = params?.[0]?.chainId ?? chainId;
            window.__qaSwitchCalls = (window.__qaSwitchCalls ?? 0) + 1;
            if (switchMode() === "silent") return null;
            if (switchMode() === "add" && !chainAdded && next !== chainId) {
              const error = new Error("Unrecognized chain ID");
              error.code = 4902;
              throw error;
            }
            chainId = next;
            setTimeout(() => emit("chainChanged", chainId), 0);
            return null;
          }
          if (method === "wallet_addEthereumChain") {
            window.__qaAddChainCalls = (window.__qaAddChainCalls ?? 0) + 1;
            if (switchMode() === "silent") return null;
            chainAdded = true;
            chainId = params?.[0]?.chainId ?? chainId;
            window.__qaLastAddedChain = chainId;
            setTimeout(() => emit("chainChanged", chainId), 0);
            return null;
          }
          if (method === "eth_getBalance") return "0x0";
          if (method === "eth_blockNumber") return "0x1";
          if (method === "eth_estimateGas") return "0x5208";
          if (method === "eth_sendTransaction") return "0x" + "11".repeat(32);
          if (method === "personal_sign") return "0x" + "11".repeat(65);
          return null;
        },
        on: (event, listener) => {
          const next = listeners.get(event) ?? [];
          next.push(listener);
          listeners.set(event, next);
        },
        removeListener: (event, listener) => {
          const next = listeners.get(event) ?? [];
          listeners.set(event, next.filter((item) => item !== listener));
        },
        enable: async () => [address],
      };
      window.__qaSetChain = (next) => {
        chainId = next;
        emit("chainChanged", chainId);
      };
      const info = {
        uuid: "9f1b0e6e-6e7a-4a2b-8e3c-tyrianqa0001",
        name: "QA Wallet",
        icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
        rdns: "com.tyrian.qa",
      };
      const announce = () =>
        window.dispatchEvent(
          new CustomEvent("eip6963:announceProvider", {
            detail: Object.freeze({ info, provider }),
          }),
        );
      window.addEventListener("eip6963:requestProvider", announce);
      setTimeout(announce, 0);
      announce();
    })();`,
  });

  try {
    await setViewport(cdp, 1440, 1000, false);
    await navigate(cdp, `${BASE}/dashboard`, false);
    const alreadyConnected = await cdp.evaluate(
      `document.querySelector("#walletBtn")?.textContent?.includes("0x") === true`,
    );
    if (!alreadyConnected) {
      await cdp.evaluate('document.querySelector("#walletBtn")?.click(); "clicked"');
      await wait(900);
      await cdp.evaluate(
        `(() => { const button = [...document.querySelectorAll("button")].find((el) => /QA Wallet/i.test(el.textContent)); button?.click(); return Boolean(button); })()`,
      );
    }
    await wait(1800);

    const openOnboarding = async () => {
      await cdp.evaluate(
        `(() => { const button = document.querySelector("#walletBtn"); button?.focus(); button?.click(); return Boolean(button); })()`,
      );
      await wait(500);
    };

    const onboardingSnapshot = async () =>
      cdp.evaluate(`(() => {
        const modal = document.querySelector(".wallet-onboarding");
        const card = document.querySelector(".wallet-modal-card");
        return {
          present: Boolean(modal),
          title: document.querySelector("#walletOnboardingTitle")?.textContent?.trim() ?? null,
          step: document.querySelector(".wallet-step.is-active")?.textContent?.trim() ?? null,
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
          cardOverflow: card ? card.scrollWidth - card.clientWidth : null,
          scrollLocked: document.documentElement.style.overflow === "hidden",
          focusInside: Boolean(card && card.contains(document.activeElement)),
          activeLabel: document.activeElement?.getAttribute("aria-label") ?? null,
        };
      })()`);

    let modal = await onboardingSnapshot();
    if (!modal.present) {
      await openOnboarding();
      modal = await onboardingSnapshot();
    }
    await setViewport(cdp, 320, 844, false, true);
    await wait(350);
    const modalAt320 = await onboardingSnapshot();
    await setViewport(cdp, 390, 844, false, true);
    await wait(350);
    const modalAt390 = await onboardingSnapshot();

    await setViewport(cdp, 1440, 1000, false);
    const pressEscape = async () => {
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
      await cdp.send("Page.bringToFront").catch(() => {});
      await cdp.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      });
      await wait(350);
    };
    await cdp.evaluate(`(() => {
      window.__escapeEvents = 0;
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") window.__escapeEvents += 1;
      });
    })()`);
    await pressEscape();
    const escaped = await cdp.evaluate(`(() => ({
      present: Boolean(document.querySelector(".wallet-onboarding")),
      focusId: document.activeElement?.id ?? null,
      hasFocus: document.hasFocus(),
      activeTag: document.activeElement?.tagName ?? null,
      activeLabel: document.activeElement?.getAttribute("aria-label") ?? null,
      escapeEvents: window.__escapeEvents ?? 0,
      rkRoots: document.querySelectorAll("[data-rk]").length,
    }))()`);

    await openOnboarding();
    const reopened = await onboardingSnapshot();
    await pressEscape();
    const escapedAgain = await cdp.evaluate(`(() => ({
      present: Boolean(document.querySelector(".wallet-onboarding")),
      focusId: document.activeElement?.id ?? null,
    }))()`);

    await openOnboarding();
    await cdp.evaluate(
      `(() => { const button = [...document.querySelectorAll(".wallet-onboarding button")].find((el) => /Sign in with wallet/i.test(el.textContent)); button?.click(); return Boolean(button); })()`,
    );
    await wait(1800);
    const signInError = await cdp.evaluate(`(() => {
      const modal = document.querySelector(".wallet-onboarding");
      return {
        present: Boolean(modal),
        error: modal?.querySelector(".wallet-error")?.textContent?.trim() ?? null,
        buttonDisabled: [...(modal?.querySelectorAll("button") ?? [])].some(
          (button) => /Sign in with wallet/i.test(button.textContent) && button.disabled,
        ),
      };
    })()`);
    await cdp.evaluate(
      `(() => { const button = [...document.querySelectorAll(".wallet-onboarding button")].find((el) => /Not now/i.test(el.textContent)); button?.click(); return Boolean(button); })()`,
    );

    // Wrong network -> network step -> switch -> sign-in step. Reload with a
    // one-off localStorage hint so the injected provider starts on chain 1.
    await cdp.evaluate(`localStorage.setItem("qa-chain", "0x1"); location.reload(); "reloading"`);
    await wait(600);
    await waitForReady(cdp);
    await wait(2200);
    const wrongNetworkConnected = await cdp.evaluate(
      `document.querySelector("#walletBtn")?.textContent?.includes("0x") === true || document.querySelector("#walletBtn")?.textContent?.includes("Wrong network") === true`,
    );
    if (!wrongNetworkConnected) {
      await cdp.evaluate('document.querySelector("#walletBtn")?.click(); "clicked"');
      await wait(900);
      await cdp.evaluate(
        `(() => { const button = [...document.querySelectorAll("button")].find((el) => /QA Wallet/i.test(el.textContent)); button?.click(); return Boolean(button); })()`,
      );
      await wait(1600);
    }
    await openOnboarding();
    const networkStep = await cdp.evaluate(`(() => ({
      present: Boolean(document.querySelector(".wallet-onboarding")),
      title: document.querySelector("#walletOnboardingTitle")?.textContent?.trim() ?? null,
      step: document.querySelector(".wallet-step.is-active")?.textContent?.trim() ?? null,
      route: document.querySelector(".wallet-route")?.textContent?.trim() ?? null,
      routeVisible: Boolean(document.querySelector(".wallet-route")),
      switchLabel: [...document.querySelectorAll(".wallet-onboarding button")].find((button) => /Switch to/i.test(button.textContent))?.textContent?.trim() ?? null,
      switchWalletVisible: [...document.querySelectorAll(".wallet-onboarding button")].some((button) => /Use a different wallet/i.test(button.textContent)),
    }))()`);
    await cdp.evaluate(
      `(() => { const button = [...document.querySelectorAll(".wallet-onboarding button")].find((el) => /Switch to/i.test(el.textContent)); button?.click(); return Boolean(button); })()`,
    );
    await wait(1400);
    const switched = await onboardingSnapshot();

    // 4902 -> the connector must call wallet_addEthereumChain and continue.
    await cdp.evaluate(
      `localStorage.setItem("qa-chain", "0x1"); localStorage.setItem("qa-switch-mode", "add"); location.reload(); "reloading"`,
    );
    await wait(600);
    await waitForReady(cdp);
    await wait(2200);
    const addChainConnected = await cdp.evaluate(
      `document.querySelector("#walletBtn")?.textContent?.includes("0x") === true || document.querySelector("#walletBtn")?.textContent?.includes("Wrong network") === true`,
    );
    if (!addChainConnected) {
      await cdp.evaluate('document.querySelector("#walletBtn")?.click(); "clicked"');
      await wait(900);
      await cdp.evaluate(
        `(() => { const button = [...document.querySelectorAll("button")].find((el) => /QA Wallet/i.test(el.textContent)); button?.click(); return Boolean(button); })()`,
      );
      await wait(1600);
    }
    await openOnboarding();
    await cdp.evaluate(
      `(() => { const button = [...document.querySelectorAll(".wallet-onboarding button")].find((el) => /Switch to/i.test(el.textContent)); button?.click(); return Boolean(button); })()`,
    );
    await wait(2200);
    const addChainSwitch = await cdp.evaluate(`(() => {
      const modal = document.querySelector(".wallet-onboarding");
      return {
        present: Boolean(modal),
        step: document.querySelector(".wallet-step.is-active")?.textContent?.trim() ?? null,
        error: modal?.querySelector(".wallet-error")?.textContent?.trim() ?? null,
        addChainCalls: window.__qaAddChainCalls ?? 0,
        addedChain: window.__qaLastAddedChain ?? null,
        switchCalls: window.__qaSwitchCalls ?? 0,
      };
    })()`);

    // A wallet can resolve `wallet_switchEthereumChain` without actually
    // changing chains. The modal must stay on the network step and verify the
    // real `eth_chainId` instead of flashing into sign-in.
    await cdp.evaluate(
      `localStorage.setItem("qa-chain", "0x1"); localStorage.setItem("qa-switch-mode", "silent"); location.reload(); "reloading"`,
    );
    await wait(600);
    await waitForReady(cdp);
    await wait(2200);
    const silentConnected = await cdp.evaluate(
      `document.querySelector("#walletBtn")?.textContent?.includes("0x") === true || document.querySelector("#walletBtn")?.textContent?.includes("Wrong network") === true`,
    );
    if (!silentConnected) {
      await cdp.evaluate('document.querySelector("#walletBtn")?.click(); "clicked"');
      await wait(900);
      await cdp.evaluate(
        `(() => { const button = [...document.querySelectorAll("button")].find((el) => /QA Wallet/i.test(el.textContent)); button?.click(); return Boolean(button); })()`,
      );
      await wait(1600);
    }
    await openOnboarding();
    await cdp.evaluate(
      `(() => { const button = [...document.querySelectorAll(".wallet-onboarding button")].find((el) => /Switch to/i.test(el.textContent)); button?.click(); return Boolean(button); })()`,
    );
    await wait(2200);
    const silentSwitch = await cdp.evaluate(`(() => {
      const modal = document.querySelector(".wallet-onboarding");
      return {
        present: Boolean(modal),
        step: document.querySelector(".wallet-step.is-active")?.textContent?.trim() ?? null,
        title: document.querySelector("#walletOnboardingTitle")?.textContent?.trim() ?? null,
        error: modal?.querySelector(".wallet-error")?.textContent?.trim() ?? null,
        addChainCalls: window.__qaAddChainCalls ?? 0,
        switchCalls: window.__qaSwitchCalls ?? 0,
      };
    })()`);

    // Escape hatch: disconnect the current wallet and reopen the picker.
    await cdp.evaluate(
      `(() => { const button = [...document.querySelectorAll(".wallet-onboarding button")].find((el) => /Use a different wallet/i.test(el.textContent)); button?.click(); return Boolean(button); })()`,
    );
    await wait(1400);
    const switchedWallet = await cdp.evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"][data-rk]');
      return {
        onboardingPresent: Boolean(document.querySelector(".wallet-onboarding")),
        walletButton: document.querySelector("#walletBtn")?.textContent?.trim() ?? null,
        rainbowKitModal: Boolean(dialog),
        rainbowKitTitle: dialog?.querySelector("[data-testid='rk-connect-header-label']")?.textContent?.trim() ?? null,
      };
    })()`);

    flows.walletOnboarding = {
      modal,
      at320: modalAt320,
      at390: modalAt390,
      escaped,
      reopened,
      escapedAgain,
      signInError,
      networkStep,
      switched,
      addChainSwitch,
      silentSwitch,
      switchedWallet,
    };
  } finally {
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: qaProvider });
    await cdp.send("Storage.clearDataForOrigin", {
      origin: BASE,
      storageTypes: "all",
    });
    await setViewport(cdp, 1440, 1000, false);
  }

  // Modern EIP-6963 discovery: MetaMask and Phantom both announce themselves,
  // even though Phantom does not own `window.ethereum` here. MetaMask must
  // connect normally, and Phantom must explain that Robinhood Chain has to be
  // enabled before its switch can succeed.
  await navigate(cdp, "about:blank", false);
  await cdp.send("Storage.clearDataForOrigin", {
    origin: BASE,
    storageTypes: "all",
  });
  const phantomAddress = "0x4444444444444444444444444444444444444444";
  const metaMaskAddress = "0x3333333333333333333333333333333333333333";
  const { identifier: walletProviders } = await cdp.send(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source: `(() => {
        const icon = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>";
        const makeProvider = (kind, address, initialChain) => {
          const listeners = new Map();
          let authorized = false;
          let chainId = initialChain;
          const emit = (event, value) => {
            for (const listener of listeners.get(event) ?? []) listener(value);
          };
          return {
            isPhantom: kind === "phantom" ? true : undefined,
            isMetaMask: kind === "metamask" ? true : undefined,
            selectedAddress: address,
            get chainId() {
              return chainId;
            },
            set chainId(value) {
              chainId = value;
            },
            setChain(next) {
              chainId = next;
              setTimeout(() => emit("chainChanged", chainId), 0);
            },
            request: async ({ method, params }) => {
              if (method === "eth_requestAccounts") {
                authorized = true;
                return [address];
              }
              if (method === "eth_accounts") return authorized ? [address] : [];
              if (method === "eth_chainId") return chainId;
              if (method === "net_version") return String(parseInt(chainId, 16));
              if (method === "wallet_switchEthereumChain") {
                const next = params?.[0]?.chainId ?? chainId;
                if (kind === "phantom") {
                  window.__qaPhantomSwitchCalls = (window.__qaPhantomSwitchCalls ?? 0) + 1;
                  if (localStorage.getItem("qa-phantom-mode") !== "ok") return null;
                } else {
                  window.__qaMetaMaskSwitchCalls = (window.__qaMetaMaskSwitchCalls ?? 0) + 1;
                }
                chainId = next;
                setTimeout(() => emit("chainChanged", chainId), 0);
                return null;
              }
              if (method === "wallet_addEthereumChain") {
                if (kind === "phantom") {
                  window.__qaPhantomAddCalls = (window.__qaPhantomAddCalls ?? 0) + 1;
                  return null;
                }
                chainId = params?.[0]?.chainId ?? chainId;
                setTimeout(() => emit("chainChanged", chainId), 0);
                return null;
              }
              if (method === "personal_sign") return "0x" + "11".repeat(65);
              return null;
            },
            on: (event, listener) => {
              const next = listeners.get(event) ?? [];
              next.push(listener);
              listeners.set(event, next);
            },
            removeListener: (event, listener) => {
              const next = listeners.get(event) ?? [];
              listeners.set(event, next.filter((item) => item !== listener));
            },
            enable: async () => [address],
          };
        };
        const phantom = makeProvider("phantom", "${phantomAddress}", "0x1");
        const metaMask = makeProvider("metamask", "${metaMaskAddress}", "0xb626");
        window.phantom = { ethereum: phantom };
        window.ethereum = metaMask;
        window.__qaPhantomSetChain = (next) => {
          phantom.setChain(next);
        };
        const infos = [
          {
            uuid: "9f1b0e6e-6e7a-4a2b-8e3c-tyrianmm0001",
            name: "MetaMask",
            icon,
            rdns: "io.metamask",
          },
          {
            uuid: "9f1b0e6e-6e7a-4a2b-8e3c-tyrianph0001",
            name: "Phantom",
            icon,
            rdns: "app.phantom",
          },
        ];
        const announce = () => {
          window.dispatchEvent(
            new CustomEvent("eip6963:announceProvider", {
              detail: Object.freeze({ info: infos[0], provider: metaMask }),
            }),
          );
          window.dispatchEvent(
            new CustomEvent("eip6963:announceProvider", {
              detail: Object.freeze({ info: infos[1], provider: phantom }),
            }),
          );
        };
        window.addEventListener("eip6963:requestProvider", announce);
        announce();
        setTimeout(announce, 0);
      })();`,
    },
  );

  try {
    await navigate(cdp, `${BASE}/`, false);
    await cdp.evaluate('document.querySelector("#walletBtn")?.click(); "clicked"');
    let picker = { present: false, metaMaskVisible: false, phantomVisible: false };
    for (let attempt = 0; attempt < 16; attempt += 1) {
      picker = await cdp.evaluate(`(() => {
        const dialog = document.querySelector('[role="dialog"][data-rk]');
        const buttons = [...(dialog?.querySelectorAll("button") ?? [])];
        return {
          present: Boolean(dialog),
          metaMaskVisible: buttons.some((button) => /MetaMask/i.test(button.textContent)),
          phantomVisible: buttons.some((button) => /Phantom/i.test(button.textContent)),
        };
      })()`);
      if (picker.present && picker.metaMaskVisible && picker.phantomVisible) break;
      await wait(250);
    }
    const clickedMetaMask = await cdp.evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"][data-rk]');
      const button = [...(dialog?.querySelectorAll("button") ?? [])].find(
        (item) => /MetaMask/i.test(item.textContent),
      );
      button?.click();
      return Boolean(button);
    })()`);
    await wait(2000);
    const metaMaskConnected = await cdp.evaluate(`(() => ({
      connectedAddress: document.querySelector(".wallet-account .mono")?.textContent?.trim() ?? null,
      walletButton: document.querySelector("#walletBtn")?.textContent?.trim() ?? null,
      onboardingPresent: Boolean(document.querySelector(".wallet-onboarding")),
      step: document.querySelector(".wallet-step.is-active")?.textContent?.trim() ?? null,
    }))()`);

    // Fresh navigation keeps the Phantom assertions independent from the
    // MetaMask session and verifies the same EIP-6963 discovery path again.
    await cdp.send("Storage.clearDataForOrigin", {
      origin: BASE,
      storageTypes: "all",
    });
    await navigate(cdp, `${BASE}/`, false);
    await cdp.evaluate('document.querySelector("#walletBtn")?.click(); "clicked"');
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const ready = await cdp.evaluate(`(() => {
        const dialog = document.querySelector('[role="dialog"][data-rk]');
        return [...(dialog?.querySelectorAll("button") ?? [])].some(
          (item) => /Phantom/i.test(item.textContent),
        );
      })()`);
      if (ready) break;
      await wait(250);
    }
    const clickedPhantom = await cdp.evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"][data-rk]');
      const button = [...(dialog?.querySelectorAll("button") ?? [])].find(
        (item) => /Phantom/i.test(item.textContent),
      );
      button?.click();
      return Boolean(button);
    })()`);
    await wait(2000);
    const phantomConnected = await cdp.evaluate(`(() => ({
      connectedAddress: document.querySelector(".wallet-account .mono")?.textContent?.trim() ?? null,
      walletButton: document.querySelector("#walletBtn")?.textContent?.trim() ?? null,
      onboardingPresent: Boolean(document.querySelector(".wallet-onboarding")),
      step: document.querySelector(".wallet-step.is-active")?.textContent?.trim() ?? null,
      hint: document.querySelector(".wallet-note")?.textContent?.trim() ?? null,
    }))()`);

    // Reproduce the real-world state mismatch: the connection briefly reports
    // the target chain, then the Phantom provider settles back on Sepolia.
    await cdp.evaluate(`window.__qaPhantomSetChain?.("0x1"); "changed"`);
    await wait(700);
    const phantomNetwork = await cdp.evaluate(`(() => ({
      step: document.querySelector(".wallet-step.is-active")?.textContent?.trim() ?? null,
      title: document.querySelector("#walletOnboardingTitle")?.textContent?.trim() ?? null,
      hint: document.querySelector(".wallet-note")?.textContent?.trim() ?? null,
    }))()`);

    const clickSwitch = async () => {
      await cdp.evaluate(
        `(() => { const button = [...document.querySelectorAll(".wallet-onboarding button")].find((el) => /Switch to/i.test(el.textContent)); button?.click(); return Boolean(button); })()`,
      );
      await wait(2200);
    };

    await clickSwitch();
    const phantomInactive = await cdp.evaluate(`(() => {
      const modal = document.querySelector(".wallet-onboarding");
      return {
        present: Boolean(modal),
        step: document.querySelector(".wallet-step.is-active")?.textContent?.trim() ?? null,
        title: document.querySelector("#walletOnboardingTitle")?.textContent?.trim() ?? null,
        error: modal?.querySelector(".wallet-error")?.textContent?.trim() ?? null,
        addCalls: window.__qaPhantomAddCalls ?? 0,
        switchCalls: window.__qaPhantomSwitchCalls ?? 0,
      };
    })()`);

    await cdp.evaluate(
      `localStorage.setItem("qa-phantom-mode", "ok"); window.__qaPhantomSetChain?.("0x1"); "ready"`,
    );
    await clickSwitch();
    const phantomActive = await cdp.evaluate(`(() => {
      const modal = document.querySelector(".wallet-onboarding");
      return {
        present: Boolean(modal),
        step: document.querySelector(".wallet-step.is-active")?.textContent?.trim() ?? null,
        title: document.querySelector("#walletOnboardingTitle")?.textContent?.trim() ?? null,
        error: modal?.querySelector(".wallet-error")?.textContent?.trim() ?? null,
        switchCalls: window.__qaPhantomSwitchCalls ?? 0,
        signInVisible: [...(modal?.querySelectorAll("button") ?? [])].some(
          (button) => /Sign in with wallet/i.test(button.textContent),
        ),
      };
    })()`);

    flows.walletDetection = {
      picker,
      clickedMetaMask,
      metaMaskConnected,
      clickedPhantom,
      phantomConnected,
      phantomNetwork,
      phantomInactive,
      phantomActive,
    };
  } finally {
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: walletProviders });
    await cdp.send("Storage.clearDataForOrigin", {
      origin: BASE,
      storageTypes: "all",
    });
  }

  return flows;
}

function summarizeMatrix(matrix) {
  const failures = [];
  for (const entry of matrix) {
    for (const [width, data] of Object.entries(entry.widths)) {
      if (data.overflow !== 0 || data.bodyOverflow !== 0 || data.maxScrollLeft > 0) {
        failures.push({
          route: entry.route,
          width: Number(width),
          overflow: data.overflow,
          bodyOverflow: data.bodyOverflow,
          maxScrollLeft: data.maxScrollLeft,
        });
      }
    }
  }
  return failures;
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  let templateServer;
  if (USE_TEMPLATE && DO_SCREENS) {
    templateServer = await startTemplateServer();
  }

  const cdp = await connectCdp();
  const report = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    templateBase: USE_TEMPLATE ? `http://127.0.0.1:${TEMPLATE_PORT}` : null,
    matrix: null,
    matrixFailures: null,
    console: null,
    flows: null,
    screenshots: [],
  };

  try {
    if (DO_SCREENS) {
      report.screenshots.push(
        ...(await shootSuite(cdp, {
          name: "frontend",
          base: BASE,
          routes: FRONTEND_ROUTES,
          outDir: path.join(OUT, "frontend"),
        })),
      );
      if (USE_TEMPLATE) {
        report.screenshots.push(
          ...(await shootSuite(cdp, {
            name: "template",
            base: `http://127.0.0.1:${TEMPLATE_PORT}`,
            routes: TEMPLATE_ROUTES,
            outDir: path.join(OUT, "template"),
          })),
        );
      }
    }
    if (DO_MATRIX) {
      report.matrix = await matrixSuite(cdp);
      report.matrixFailures = summarizeMatrix(report.matrix);
    }
    if (DO_CONSOLE) {
      report.console = await consoleSuite(cdp);
    }
    if (DO_FLOWS) {
      report.flows = await flowSuite(cdp);
    }
  } finally {
    cdp.close();
    if (templateServer) await new Promise((resolve) => templateServer.close(resolve));
  }

  const reportPath = path.join(OUT, "report.json");
  let previous = {};
  try {
    previous = JSON.parse(await fs.readFile(reportPath, "utf8"));
  } catch {
    // First run in this directory.
  }
  const merged = {
    ...previous,
    generatedAt: report.generatedAt,
    base: report.base,
    templateBase: report.templateBase ?? previous.templateBase ?? null,
  };
  if (DO_SCREENS) merged.screenshots = report.screenshots;
  if (DO_MATRIX) {
    merged.matrix = report.matrix;
    merged.matrixFailures = report.matrixFailures;
  }
  if (DO_CONSOLE) merged.console = report.console;
  if (DO_FLOWS) merged.flows = report.flows;

  await fs.writeFile(reportPath, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`report ${path.relative(ROOT, reportPath)}`);
  console.log(JSON.stringify({ matrixFailures: report.matrixFailures, flows: report.flows }, null, 2));
}

await main();
