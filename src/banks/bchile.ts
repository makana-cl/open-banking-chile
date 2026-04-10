import * as fs from "fs";
import * as path from "path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { BankMovement, BankScraper, CreditCardBalance, ScrapeResult, ScraperOptions, MovementSource } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { DebugLog, delay, deduplicateMovements, findChrome, normalizeDate, normalizeInstallments } from "../utils.js";

// ─── Constants ───────────────────────────────────────────────────

const BANK_URL = "https://login.portales.bancochile.cl/login";
const DASHBOARD_URL = "https://portalpersonas.bancochile.cl/mibancochile-web/front/persona/index.html#/dashboard";
const MAX_PAGES = 30;

// ─── Browser helpers ─────────────────────────────────────────────

async function launchPlaywright(options: ScraperOptions): Promise<{ browser: Browser; page: Page; debugLog: string[] }> {
  const { chromePath, headful, onDebug } = options;
  const debugLog: string[] = onDebug ? new DebugLog(onDebug) : [];

  const execPath = findChrome(chromePath);
  if (!execPath) {
    throw new Error(
      "No se encontró Chrome/Chromium. Instala Google Chrome o pasa chromePath.\n" +
      "  Ubuntu/Debian: sudo apt install google-chrome-stable\n" +
      "  macOS: brew install --cask google-chrome",
    );
  }

  const browser = await chromium.launch({
    executablePath: execPath,
    headless: !headful,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
      "--disable-notifications",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const page = await context.newPage();
  return { browser, page, debugLog };
}

async function screenshotIfEnabled(page: Page, name: string, enabled: boolean, debugLog: string[]): Promise<void> {
  if (!enabled) return;
  const safeName = name.replace(/[/\\:*?"<>|]/g, "_");
  const dir = path.resolve("screenshots");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${safeName}.png`), fullPage: true });
  debugLog.push(`  Screenshot: ${safeName}.png`);
}

// ─── Popup / overlay dismissal ──────────────────────────────────

async function dismissOverlays(page: Page, debugLog: string[]): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const hasOverlay = await page.locator(".cdk-overlay-container .fondo, .cdk-overlay-backdrop")
      .first().isVisible({ timeout: 2000 }).catch(() => false);
    if (!hasOverlay) break;

    debugLog.push(`  Closing overlay (attempt ${attempt + 1})...`);

    // Try visible close buttons inside overlay panes
    const overlayBtns = page.locator(".cdk-overlay-container .cdk-overlay-pane button:visible");
    const count = await overlayBtns.count();
    let closed = false;
    for (let i = 0; i < count; i++) {
      const btn = overlayBtns.nth(i);
      const text = (await btn.textContent().catch(() => ""))?.trim() || "";
      const ariaLabel = (await btn.getAttribute("aria-label").catch(() => ""))?.trim() || "";
      const classList = (await btn.getAttribute("class").catch(() => ""))?.trim() || "";
      const isClose = text === "" || text === "×" || text === "X" || text.toLowerCase() === "close"
        || ariaLabel.toLowerCase().includes("close") || ariaLabel.toLowerCase().includes("cerrar")
        || classList.includes("close");
      if (isClose) {
        await btn.click({ force: true });
        closed = true;
        await delay(1000);
        break;
      }
    }

    if (!closed) {
      // Force-remove overlay via JS
      await page.evaluate(`(() => {
        var c = document.querySelector(".cdk-overlay-container");
        if (c) { c.querySelectorAll(".fondo, .cdk-overlay-backdrop").forEach(function(el) { el.remove(); }); c.querySelectorAll(".cdk-overlay-pane").forEach(function(el) { el.remove(); }); }
      })()`);
      await delay(1000);
    }
  }
}

// ─── Login ───────────────────────────────────────────────────────

async function login(
  page: Page,
  rut: string,
  password: string,
  debugLog: string[],
  doScreenshots: boolean,
  progress: (s: string) => void,
): Promise<{ success: true; dashboardUrl: string } | { success: false; error: string; screenshot?: string }> {
  debugLog.push("1. Navigating to Banco de Chile login...");
  progress("Abriendo sitio del banco...");
  await page.goto(BANK_URL, { waitUntil: "networkidle" });
  await delay(2000);
  await screenshotIfEnabled(page, "01-homepage", doScreenshots, debugLog);

  // Fill RUT
  debugLog.push("2. Filling RUT...");
  progress("Ingresando RUT...");
  const rutInput = page.getByRole("textbox", { name: "RUT" });
  try {
    await rutInput.click({ timeout: 10000 });
    await rutInput.fill(rut);
  } catch {
    const ss = (await page.screenshot()).toString("base64");
    return { success: false, error: "No se encontró campo de RUT", screenshot: ss };
  }
  await delay(1000);

  // Fill password
  debugLog.push("3. Filling password...");
  progress("Ingresando clave...");
  const passInput = page.getByRole("textbox", { name: "Contraseña" });
  try {
    await passInput.click({ timeout: 5000 });
    await passInput.fill(password);
  } catch {
    const ss = (await page.screenshot()).toString("base64");
    return { success: false, error: "No se encontró campo de contraseña", screenshot: ss };
  }
  await delay(500);
  await screenshotIfEnabled(page, "02-login-filled", doScreenshots, debugLog);

  // Submit
  debugLog.push("4. Submitting login...");
  progress("Iniciando sesión...");
  await page.getByRole("button", { name: "Ingresar a cuenta" }).click();
  await page.waitForLoadState("networkidle").catch(() => {});
  await delay(8000);
  await screenshotIfEnabled(page, "03-post-login", doScreenshots, debugLog);

  // 2FA check
  const content = await page.content();
  if (content.toLowerCase().includes("clave dinámica") || content.toLowerCase().includes("segundo factor") || content.toLowerCase().includes("verificación")) {
    const timeoutSec = parseInt(process.env.BCHILE_2FA_TIMEOUT_SEC || "0", 10);
    if (timeoutSec > 0) {
      debugLog.push(`  2FA detected — waiting up to ${timeoutSec}s...`);
      progress("Esperando aprobación de 2FA...");
      const approved = await page.waitForFunction(() => {
        const body = document.body?.innerText?.toLowerCase() || "";
        return !body.includes("clave dinámica") && !body.includes("segundo factor") && !body.includes("verificación");
      }, { timeout: timeoutSec * 1000 }).then(() => true, () => false);
      if (!approved) {
        const ss = (await page.screenshot()).toString("base64");
        return { success: false, error: "Timeout esperando aprobación de 2FA.", screenshot: ss };
      }
      await delay(3000);
    } else {
      const ss = (await page.screenshot()).toString("base64");
      return { success: false, error: "El banco pide 2FA. Configura BCHILE_2FA_TIMEOUT_SEC para esperar.", screenshot: ss };
    }
  }

  // Error check
  const errorText = await page.locator('[class*="error"], [class*="alert"], [role="alert"]')
    .first().textContent({ timeout: 2000 }).catch(() => null);
  if (errorText && errorText.trim().length > 5 && errorText.trim().length < 200) {
    const lower = errorText.toLowerCase();
    if (lower.includes("clave incorrecta") || lower.includes("rut inválido") || lower.includes("bloqueada") || lower.includes("suspendida")) {
      const ss = (await page.screenshot()).toString("base64");
      return { success: false, error: `Error del banco: ${errorText.trim()}`, screenshot: ss };
    }
  }

  // Still on login page?
  if (page.url().includes("/login")) {
    const ss = (await page.screenshot()).toString("base64");
    return { success: false, error: "Login falló — aún en página de login", screenshot: ss };
  }

  debugLog.push("5. Login OK!");
  progress("Sesión iniciada correctamente");

  // Save dashboard URL for robust navigation later
  const dashboardUrl = page.url();

  // Dismiss marketing popups
  await dismissOverlays(page, debugLog);
  await delay(1000);

  return { success: true, dashboardUrl };
}

// ─── Movement extraction from tables ────────────────────────────
// Injected as addScriptTag to avoid tsx/esbuild __name transform issues

async function injectExtractor(page: Page): Promise<void> {
  const alreadyInjected = await page.evaluate(`typeof window.__obcExtractMovements === "function"`) as boolean;
  if (alreadyInjected) return;

  await page.addScriptTag({
    content: `
      window.__obcExtractMovements = function(src) {
        var results = [];
        var tables = Array.from(document.querySelectorAll("table"));
        for (var t = 0; t < tables.length; t++) {
          var table = tables[t];
          var rows = Array.from(table.querySelectorAll("tr"));
          if (rows.length < 2) continue;
          var dateIdx = -1, descIdx = -1, cargoIdx = -1, abonoIdx = -1;
          var amountIdx = -1, balanceIdx = -1, cuotasIdx = -1;
          var hasHeader = false;
          for (var r = 0; r < rows.length; r++) {
            var headers = rows[r].querySelectorAll("th");
            if (headers.length < 2) continue;
            var hTexts = Array.from(headers).map(function(h) { return (h.innerText || "").trim().toLowerCase(); });
            if (!hTexts.some(function(h) { return h.includes("fecha"); })) continue;
            hasHeader = true;
            dateIdx = hTexts.findIndex(function(h) { return h.includes("fecha"); });
            descIdx = hTexts.findIndex(function(h) { return h.includes("descrip") || h.includes("detalle") || h.includes("glosa") || h.includes("comercio"); });
            cargoIdx = hTexts.findIndex(function(h) { return h.includes("cargo") || h.includes("d\\u00e9bito") || h.includes("debito") || h.includes("capital"); });
            abonoIdx = hTexts.findIndex(function(h) { return h.includes("abono") || h.includes("cr\\u00e9dito") || h.includes("credito") || h.includes("pago"); });
            amountIdx = hTexts.findIndex(function(h) { return h === "monto" || h.includes("importe") || h.includes("monto total") || h.includes("internacional"); });
            balanceIdx = hTexts.findIndex(function(h) { return h.includes("saldo"); });
            cuotasIdx = hTexts.findIndex(function(h) { return h.includes("cuota"); });
            break;
          }
          if (!hasHeader) continue;
          var lastDate = "";
          for (var r2 = 0; r2 < rows.length; r2++) {
            var cells = rows[r2].querySelectorAll("td");
            if (cells.length < 3) continue;
            var vals = Array.from(cells).map(function(c) { return (c.innerText || "").trim(); });
            var rawDate = dateIdx >= 0 ? (vals[dateIdx] || "") : "";
            var dateRe = /^\\d{1,2}[\\/\\.\\-]\\d{1,2}([\\/\\.\\-]\\d{2,4})?$/;
            var hasDate = dateRe.test(rawDate);
            var date = hasDate ? rawDate : lastDate;
            if (!date) continue;
            if (hasDate) lastDate = rawDate;
            var description = descIdx >= 0 ? (vals[descIdx] || "") : "";
            var amountStr = "";
            if (cargoIdx >= 0 && (vals[cargoIdx] || "").replace(/\\s/g, "")) {
              amountStr = "-" + vals[cargoIdx];
            } else if (abonoIdx >= 0 && (vals[abonoIdx] || "").replace(/\\s/g, "")) {
              amountStr = vals[abonoIdx];
            } else if (amountIdx >= 0) {
              amountStr = vals[amountIdx] || "";
            }
            if (!amountStr) continue;
            var balStr = balanceIdx >= 0 ? (vals[balanceIdx] || "") : "";
            var cuotasStr = cuotasIdx >= 0 ? (vals[cuotasIdx] || "") : undefined;
            var clean = amountStr.replace(/[^0-9.,-]/g, "");
            var isNeg = clean.startsWith("-") || amountStr.includes("-$");
            var norm = clean.replace(/-/g, "").replace(/\\./g, "").replace(",", ".");
            var amount = parseInt(norm, 10) || 0;
            if (isNeg) amount = -amount;
            var bClean = balStr.replace(/[^0-9.,-]/g, "");
            var bNeg = bClean.startsWith("-") || balStr.includes("-$");
            var bNorm = bClean.replace(/-/g, "").replace(/\\./g, "").replace(",", ".");
            var balance = parseInt(bNorm, 10) || 0;
            if (bNeg) balance = -balance;
            if (description || amount !== 0) {
              results.push({ date: date, description: description, amount: amount, balance: balance, source: src, installments: cuotasStr || undefined });
            }
          }
        }
        return results;
      };
    `,
  });
}

async function extractMovementsFromTable(page: Page, source: MovementSource): Promise<BankMovement[]> {
  await injectExtractor(page);
  const raw = await page.evaluate(`window.__obcExtractMovements("${source}")`) as Array<{
    date: string; description: string; amount: number; balance: number; source: string; installments?: string;
  }>;
  return raw.map(m => ({
    date: normalizeDate(m.date),
    description: m.description,
    amount: m.amount,
    balance: m.balance,
    source: m.source as MovementSource,
    ...(m.installments ? { installments: normalizeInstallments(m.installments) } : {}),
  }));
}

// ─── Pagination ─────────────────────────────────────────────────

async function paginateAndExtract(page: Page, source: MovementSource, debugLog: string[]): Promise<BankMovement[]> {
  const all: BankMovement[] = [];

  for (let i = 0; i < MAX_PAGES; i++) {
    const movements = await extractMovementsFromTable(page, source);
    all.push(...movements);
    if (i === 0) debugLog.push(`  Page 1: ${movements.length} movements`);

    // Try "Próxima página" button
    const nextBtn = page.getByRole("button", { name: "Próxima página" });
    const isVisible = await nextBtn.isVisible({ timeout: 1500 }).catch(() => false);
    if (!isVisible) break;

    const isDisabled = await nextBtn.isDisabled().catch(() => true);
    if (isDisabled) break;

    await nextBtn.click();
    await delay(2500);
    debugLog.push(`  Page ${i + 2} loaded`);
  }

  return deduplicateMovements(all);
}

// ─── Balance extraction ─────────────────────────────────────────

async function extractBalance(page: Page): Promise<number | undefined> {
  // Extract balance using text content — avoids page.evaluate with inline functions
  const bodyText = await page.locator("body").textContent().catch(() => "") || "";
  const m = bodyText.match(/Saldo\s+(?:disponible|contable)\s+(?:Cuenta\s+Corriente\s+)?\$\s*([\d.]+)/i);
  if (m) return parseInt(m[1].replace(/\./g, ""), 10) || undefined;
  const m2 = bodyText.match(/Cuenta\s+Corriente[\s\S]{0,80}\$\s*([\d.]+)/i);
  if (m2) return parseInt(m2[1].replace(/\./g, ""), 10) || undefined;
  return undefined;
}

// ─── Account movements ──────────────────────────────────────────

async function scrapeAccountMovements(
  page: Page,
  debugLog: string[],
  doScreenshots: boolean,
  progress: (s: string) => void,
): Promise<{ movements: BankMovement[]; balance?: number }> {
  debugLog.push("6. Navigating to account movements...");
  progress("Navegando a saldos y movimientos...");

  // Click "SALDOS Y MOV. CUENTAS" menu button
  const saldosBtn = page.getByRole("button", { name: /SALDOS Y MOV.*CUENTAS/i });
  if (await saldosBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await saldosBtn.click();
    await delay(2000);
  }

  // Click "Saldos y movimientos" link
  const saldosLink = page.getByRole("link", { name: /Saldos y movimientos/i });
  if (await saldosLink.isVisible({ timeout: 5000 }).catch(() => false)) {
    await saldosLink.click();
    await page.waitForLoadState("networkidle").catch(() => {});
    await delay(4000);
  }

  await dismissOverlays(page, debugLog);
  await screenshotIfEnabled(page, "04-account-movements", doScreenshots, debugLog);

  // Extract balance
  let balance = await extractBalance(page);

  // Extract and paginate movements for the default account view
  progress("Extrayendo movimientos de cuenta...");
  const movements = await paginateAndExtract(page, MOVEMENT_SOURCE.account, debugLog);
  debugLog.push(`7. Account movements: ${movements.length}`);
  progress(`Cuenta: ${movements.length} movimientos`);

  // Fallback balance from movements
  if (balance === undefined && movements.length > 0) {
    const withBalance = movements.find(m => m.balance > 0);
    if (withBalance) balance = withBalance.balance;
  }

  return { movements, balance };
}

// ─── Credit card movements ──────────────────────────────────────

async function navigateToDashboard(page: Page, dashboardUrl: string, debugLog: string[]): Promise<void> {
  debugLog.push("  Navigating to dashboard...");
  await page.goto(dashboardUrl || DASHBOARD_URL, { waitUntil: "networkidle" }).catch(() => {});
  await delay(3000);
  await dismissOverlays(page, debugLog);
}

async function scrapeSingleCreditCard(
  page: Page,
  cardIndex: number,
  debugLog: string[],
  doScreenshots: boolean,
  progress: (s: string) => void,
): Promise<{ movements: BankMovement[]; creditCard: CreditCardBalance }> {
  const allMovements: BankMovement[] = [];

  // Extract card label and cupos — uses addScriptTag to avoid tsx __name injection
  await page.addScriptTag({
    content: `
      window.__obcExtractCardInfo = window.__obcExtractCardInfo || (function() {
        var text = document.body?.innerText || "";
        var titleMatch = text.match(/T[ií]tulo\\s+((?:Visa|Mastercard|Amex)[\\w\\s]*\\*{4}\\d{4})/i);
        var label = titleMatch ? titleMatch[1].trim() : "";
        if (!label) {
          var fallback = text.match(/(Visa|Mastercard|Amex)\\s*[\\w\\s]*\\*{4}(\\d{4})/i);
          label = fallback ? (fallback[1] + " ****" + fallback[2]) : "Tarjeta de Crédito";
        }
        var totalMatch = text.match(/Cupo\\s+total[\\s\\S]{0,30}\\$\\s*([\\d.]+)/i);
        var usadoMatch = text.match(/Cupo\\s+utilizado[\\s\\S]{0,30}\\$\\s*([\\d.]+)/i);
        var disponibleMatch = text.match(/Cupo\\s+disponible[\\s\\S]{0,30}\\$\\s*([\\d.]+)/i);
        var p = function(s) { return s ? parseInt(s.replace(/\\./g, ""), 10) || 0 : 0; };
        var intTotalMatch = text.match(/Internacional[\\s\\S]{0,80}(?:Total|Cupo total)\\s+USD\\s*([\\d.,]+)/i);
        var intUsadoMatch = text.match(/Internacional[\\s\\S]{0,80}(?:Utilizado|Cupo utilizado)\\s+USD\\s*([\\d.,]+)/i);
        var intDispMatch = text.match(/Internacional[\\s\\S]{0,80}(?:Disponible|Cupo disponible)\\s+USD\\s*([\\d.,]+)/i);
        var pu = function(s) { return s ? parseFloat(s.replace(/\\./g, "").replace(",", ".")) || 0 : 0; };
        return {
          label: label,
          national: { total: p(totalMatch?.[1]), used: p(usadoMatch?.[1]), available: p(disponibleMatch?.[1]) },
          international: intTotalMatch ? { total: pu(intTotalMatch[1]), used: pu(intUsadoMatch?.[1]), available: pu(intDispMatch?.[1]), currency: "USD" } : undefined,
        };
      });
    `,
  });
  const cardInfo = await page.evaluate(`window.__obcExtractCardInfo()`) as {
    label: string;
    national: { total: number; used: number; available: number };
    international?: { total: number; used: number; available: number; currency: string };
  };

  const creditCard: CreditCardBalance = {
    label: cardInfo.label || `Tarjeta #${cardIndex + 1}`,
    ...(cardInfo.national.total > 0 ? { national: cardInfo.national } : {}),
    ...(cardInfo.international ? { international: cardInfo.international } : {}),
  };

  // ── Tab: "Saldos y movimientos No facturados" (default tab) ────
  const unbilledTab = page.locator("a, [role='tab']").filter({ hasText: /no facturado/i }).first();
  if (await unbilledTab.isVisible({ timeout: 3000 }).catch(() => false)) {
    await unbilledTab.click();
    await page.waitForLoadState("networkidle").catch(() => {});
    await delay(3000);
  }
  await screenshotIfEnabled(page, `05-tc${cardIndex}-unbilled`, doScreenshots, debugLog);

  progress(`Extrayendo movimientos TC por facturar (tarjeta ${cardIndex + 1})...`);
  const unbilledMovements = await paginateAndExtract(page, MOVEMENT_SOURCE.credit_card_unbilled, debugLog);
  debugLog.push(`  TC${cardIndex} unbilled: ${unbilledMovements.length}`);
  allMovements.push(...unbilledMovements);

  // ── Tab: "Movimientos facturados" ──────────────────────────────
  const billedTab = page.locator("a, [role='tab']").filter({ hasText: /Movimientos facturados/i }).first();
  if (await billedTab.isVisible({ timeout: 3000 }).catch(() => false)) {
    await billedTab.click();
    await page.waitForLoadState("networkidle").catch(() => {});
    await delay(3000);
    await screenshotIfEnabled(page, `06-tc${cardIndex}-billed`, doScreenshots, debugLog);

    progress(`Extrayendo movimientos TC facturados (tarjeta ${cardIndex + 1})...`);
    const billedMovements = await paginateAndExtract(page, MOVEMENT_SOURCE.credit_card_billed, debugLog);
    debugLog.push(`  TC${cardIndex} billed: ${billedMovements.length}`);
    allMovements.push(...billedMovements);
  }

  creditCard.movements = deduplicateMovements(allMovements);

  return { movements: allMovements, creditCard };
}

async function scrapeCreditCardMovements(
  page: Page,
  dashboardUrl: string,
  debugLog: string[],
  doScreenshots: boolean,
  progress: (s: string) => void,
): Promise<{ movements: BankMovement[]; creditCards: CreditCardBalance[] }> {
  const allMovements: BankMovement[] = [];
  const creditCards: CreditCardBalance[] = [];

  debugLog.push("8. Navigating to credit card section...");
  progress("Navegando a tarjetas de crédito...");

  // Go to dashboard first for a clean starting point
  await navigateToDashboard(page, dashboardUrl, debugLog);

  // Click "TARJETA DE CRÉDITO" menu
  const tcMenuBtn = page.getByRole("button", { name: /TARJETA.*CR[EÉ]DITO/i })
    .or(page.locator("button, a").filter({ hasText: /tarjeta.*cr[eé]dito/i }).first());
  if (await tcMenuBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await tcMenuBtn.click({ force: true });
    await delay(2000);
  }

  // Click "Últimos movimientos" or similar entry link
  const tcEntryLink = page.getByRole("link", { name: /[Úú]ltimos movimientos/i }).first()
    .or(page.getByRole("link", { name: /movimientos.*tarjeta/i }).first())
    .or(page.locator("a").filter({ hasText: /[úu]ltimos movimientos/i }).first());
  if (await tcEntryLink.isVisible({ timeout: 5000 }).catch(() => false)) {
    await tcEntryLink.click();
    await page.waitForLoadState("networkidle").catch(() => {});
    await delay(4000);
  }

  await dismissOverlays(page, debugLog);

  // Check if we landed on a TC page
  const hasTcContent = await page.locator("text=/Visa|Mastercard|Amex|facturado/i")
    .first().isVisible({ timeout: 5000 }).catch(() => false);

  if (!hasTcContent) {
    // Fallback: try clicking directly on a card product from dashboard
    debugLog.push("  TC section not found via menu, trying product cards...");
    await navigateToDashboard(page, dashboardUrl, debugLog);
    const cardLinks = page.locator("a").filter({ hasText: /Visa|Mastercard|Amex/i });
    const cardCount = await cardLinks.count();
    if (cardCount === 0) {
      debugLog.push("  No credit cards found.");
      return { movements: [], creditCards: [] };
    }
    await cardLinks.first().click();
    await page.waitForLoadState("networkidle").catch(() => {});
    await delay(4000);
    await dismissOverlays(page, debugLog);
  }

  // Scrape the first/current card
  const result = await scrapeSingleCreditCard(page, 0, debugLog, doScreenshots, progress);
  allMovements.push(...result.movements);
  creditCards.push(result.creditCard);

  // Check for additional cards — look for card selector or multiple card links
  // Some banks have a dropdown or links to switch between cards
  const cardSelector = page.locator("select").filter({ hasText: /Visa|Mastercard|Amex/i }).first();
  if (await cardSelector.isVisible({ timeout: 2000 }).catch(() => false)) {
    const options = await cardSelector.locator("option").allTextContents();
    for (let i = 1; i < options.length; i++) {
      debugLog.push(`  Switching to card: ${options[i].trim()}`);
      await cardSelector.selectOption({ index: i });
      await delay(3000);
      const extraResult = await scrapeSingleCreditCard(page, i, debugLog, doScreenshots, progress);
      allMovements.push(...extraResult.movements);
      creditCards.push(extraResult.creditCard);
    }
  }

  debugLog.push(`9. TC total: ${allMovements.length} movements across ${creditCards.length} card(s)`);
  progress(`Tarjeta: ${allMovements.length} movimientos (${creditCards.length} tarjeta${creditCards.length > 1 ? "s" : ""})`);

  return { movements: allMovements, creditCards };
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeBchile(options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, saveScreenshots: doScreenshots = false } = options;
  const progress = options.onProgress || (() => {});
  const bank = "bchile";

  if (!rut || !password) {
    return { success: false, bank, accounts: [], error: "Debes proveer RUT y clave." };
  }

  let browser: Browser | undefined;

  try {
    const session = await launchPlaywright(options);
    browser = session.browser;
    const { page, debugLog } = session;

    // Login
    const loginResult = await login(page, rut, password, debugLog, doScreenshots, progress);
    if (!loginResult.success) {
      return {
        success: false, bank, accounts: [],
        error: loginResult.error, screenshot: loginResult.screenshot,
        debug: debugLog.join("\n"),
      };
    }

    const dashboardUrl = loginResult.dashboardUrl;

    // Phase 1: Account movements
    const { movements: accountMovements, balance } = await scrapeAccountMovements(page, debugLog, doScreenshots, progress);

    // Phase 2: Credit card movements (navigates to dashboard internally)
    const { movements: tcMovements, creditCards } = await scrapeCreditCardMovements(
      page, dashboardUrl, debugLog, doScreenshots, progress,
    );

    const totalMov = accountMovements.length + tcMovements.length;
    debugLog.push(`10. Total: ${accountMovements.length} account + ${tcMovements.length} TC = ${totalMov}`);
    progress(`Listo — ${totalMov} movimientos totales`);

    await screenshotIfEnabled(page, "07-final", doScreenshots, debugLog);
    const ss = doScreenshots ? (await page.screenshot({ fullPage: true })).toString("base64") : undefined;

    // Logout
    try {
      const logoutBtn = page.getByRole("button", { name: /cerrar sesión/i });
      if (await logoutBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await logoutBtn.click();
        await delay(2000);
      }
    } catch { /* best effort */ }

    return {
      success: true,
      bank,
      accounts: [{ balance, movements: deduplicateMovements(accountMovements) }],
      creditCards: creditCards.length > 0 ? creditCards : undefined,
      screenshot: ss,
      debug: debugLog.join("\n"),
    };
  } catch (error) {
    return {
      success: false, bank, accounts: [],
      error: `Error del scraper: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── Export ──────────────────────────────────────────────────────

const bchilePlaywright: BankScraper = {
  id: "bchile",
  name: "Banco de Chile",
  url: BANK_URL,
  scrape: scrapeBchile,
};

export default bchilePlaywright;
