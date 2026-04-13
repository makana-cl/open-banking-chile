import * as fs from "fs";
import * as path from "path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { BankMovement, BankScraper, CreditCardBalance, ScrapeResult, ScraperOptions, MovementSource } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { DebugLog, delay, deduplicateMovements, findChrome, normalizeDate, normalizeInstallments, parseChileanAmount } from "../utils.js";
import { handleValidateOnly } from "../actions/validate.js";

// ─── Constants ───────────────────────────────────────────────────

const BANK_URL = "https://www.bancoconsorcio.cl";
const NAV_TIMEOUT = 10000;
const SHORT_TIMEOUT = 5000;

// ─── Browser ─────────────────────────────────────────────────────

async function launchBrowser(options: ScraperOptions): Promise<{ browser: Browser; context: BrowserContext; page: Page; debugLog: string[] }> {
  const { chromePath, headful, onDebug } = options;
  const debugLog: string[] = onDebug ? new DebugLog(onDebug) as unknown as string[] : [];

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
    ignoreDefaultArgs: ["--enable-automation"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const page = await context.newPage();
  return { browser, context, page, debugLog };
}

// ─── Helpers ─────────────────────────────────────────────────────

async function screenshot(page: Page, name: string, enabled: boolean, debugLog: string[]): Promise<void> {
  if (!enabled) return;
  const safeName = name.replace(/[/\\:*?"<>|]/g, "_");
  const dir = path.resolve("screenshots");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${safeName}.png`), fullPage: true });
  debugLog.push(`  📸 ${safeName}.png`);
}

async function waitForNav(page: Page, ms = 1500): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => {});
  await delay(ms);
}

async function clickFirst(page: Page, strategies: Array<() => ReturnType<Page["locator"]>>, timeout = SHORT_TIMEOUT): Promise<boolean> {
  for (const strategy of strategies) {
    try {
      const loc = strategy();
      if (await loc.isVisible({ timeout }).catch(() => false)) {
        await loc.click();
        return true;
      }
    } catch { /* try next */ }
  }
  return false;
}

// ─── Login ───────────────────────────────────────────────────────

async function login(
  page: Page,
  rut: string,
  password: string,
  debugLog: string[],
  doScreenshots: boolean,
  progress: (s: string) => void,
): Promise<{ success: true } | { success: false; error: string; screenshot?: string }> {

  debugLog.push("1. Navigating to Banco Consorcio...");
  progress("Abriendo sitio de Banco Consorcio...");
  await page.goto(BANK_URL, { waitUntil: "networkidle", timeout: 30000 });
  await delay(2000);
  await screenshot(page, "01-homepage", doScreenshots, debugLog);

  // 2. Click "Acceso Clientes"
  debugLog.push("2. Opening Acceso Clientes...");
  progress("Abriendo menú de acceso...");
  const clickedAcceso = await clickFirst(page, [
    () => page.getByRole("button", { name: /Acceso Clientes/i }),
    () => page.locator("button, a").filter({ hasText: /Acceso Clientes/i }).first(),
  ], NAV_TIMEOUT);

  if (!clickedAcceso) {
    const ss = (await page.screenshot()).toString("base64");
    return { success: false, error: "No se encontró botón 'Acceso Clientes'", screenshot: ss };
  }
  await delay(1500);

  // 3. Click "Acceder a Personas"
  debugLog.push("3. Clicking 'Acceder a Personas'...");
  const clickedPersonas = await clickFirst(page, [
    () => page.getByLabel("Acceder a Personas"),
    () => page.getByRole("link", { name: /Acceder a Personas/i }),
    () => page.locator("a").filter({ hasText: /Personas/i }).first(),
  ], SHORT_TIMEOUT);

  if (!clickedPersonas) {
    const ss = (await page.screenshot()).toString("base64");
    return { success: false, error: "No se encontró link 'Acceder a Personas'", screenshot: ss };
  }

  await waitForNav(page, 3000);

  // 4. Fill RUT — type char by char
  debugLog.push("4. Filling RUT...");
  progress("Ingresando RUT...");
  const cleanRut = rut.replace(/[.\-\s]/g, "");
  try {
    const rutField = page.locator("#input-rut");
    await rutField.click({ timeout: NAV_TIMEOUT });
    await rutField.pressSequentially(cleanRut, { delay: 40 });
  } catch {
    const ss = (await page.screenshot()).toString("base64");
    return { success: false, error: "No se encontró campo de RUT (#input-rut)", screenshot: ss };
  }
  await delay(300);

  // 5. Fill password — type char by char
  debugLog.push("5. Filling password...");
  progress("Ingresando clave...");
  try {
    const passField = page.locator("#input-new-pass");
    await passField.click({ timeout: SHORT_TIMEOUT });
    await passField.pressSequentially(password, { delay: 40 });
  } catch {
    const ss = (await page.screenshot()).toString("base64");
    return { success: false, error: "No se encontró campo de contraseña (#input-new-pass)", screenshot: ss };
  }
  await delay(300);

  // Toggle password visibility (click eye icon)
  await clickFirst(page, [
    () => page.locator(".icon-input-right.icon-input-cursor"),
    () => page.locator("#input-new-passcontainer").getByRole("img"),
  ], 2000);
  await delay(200);

  // 6. Submit
  debugLog.push("6. Submitting login...");
  progress("Iniciando sesión...");
  try {
    await page.getByRole("button", { name: "Ingresar" }).click({ timeout: SHORT_TIMEOUT });
  } catch {
    await page.locator("button[type='submit'], input[type='submit']").first().click();
  }
  await waitForNav(page, 5000);
  await screenshot(page, "05-post-login", doScreenshots, debugLog);

  // ── Post-login checks ──────────────────────────────────────
  const body = await page.locator("body").textContent().catch(() => "") || "";
  const lower = body.toLowerCase();

  if (lower.includes("acceso restringido") || lower.includes("bloqueado") || lower.includes("error de seguridad")) {
    const ss = (await page.screenshot()).toString("base64");
    return { success: false, error: "Acceso bloqueado por seguridad del banco.", screenshot: ss };
  }

  if (lower.includes("clave incorrecta") || lower.includes("rut inválido") || lower.includes("datos incorrectos") || lower.includes("cuenta bloqueada") || lower.includes("credenciales inválidas")) {
    const ss = (await page.screenshot()).toString("base64");
    return { success: false, error: "Credenciales incorrectas o cuenta bloqueada.", screenshot: ss };
  }

  // 2FA check
  if (lower.includes("clave dinámica") || lower.includes("segundo factor") || lower.includes("código de seguridad")) {
    const timeoutSec = parseInt(process.env.CONSORCIO_2FA_TIMEOUT_SEC || "0", 10);
    if (timeoutSec > 0) {
      debugLog.push(`  2FA detected — waiting up to ${timeoutSec}s...`);
      progress("Esperando aprobación de 2FA...");
      const approved = await page.waitForFunction(() => {
        const t = document.body?.innerText?.toLowerCase() || "";
        return !t.includes("clave dinámica") && !t.includes("segundo factor") && !t.includes("código de seguridad");
      }, { timeout: timeoutSec * 1000 }).then(() => true, () => false);
      if (!approved) {
        const ss = (await page.screenshot()).toString("base64");
        return { success: false, error: "Timeout esperando aprobación de 2FA.", screenshot: ss };
      }
      await delay(3000);
    } else {
      const ss = (await page.screenshot()).toString("base64");
      return { success: false, error: "El banco pide 2FA. Configura CONSORCIO_2FA_TIMEOUT_SEC para esperar.", screenshot: ss };
    }
  }

  // Dismiss post-login modals
  for (let i = 0; i < 3; i++) {
    const dismissed = await clickFirst(page, [
      () => page.locator(".cns-modal--content--heading--close--icon > svg").first(),
      () => page.locator("[class*='close-modal'], [class*='cerrar'], [class*='close']").first(),
    ], 2000);
    if (!dismissed) break;
    await delay(800);
  }

  debugLog.push("7. Login OK ✓");
  progress("Sesión iniciada correctamente");
  return { success: true };
}

// ─── Movement extraction ────────────────────────────────────────
// Consorcio uses a Vue <cns-table> component with slotted divs:
//   slot="Fecha0", slot="Descripción0", slot="Serie0", slot="Cargo/Abono0", slot="Saldo0"
// The index increments per row: Fecha0, Fecha1, Fecha2, ...

async function injectExtractor(page: Page): Promise<void> {
  const alreadyInjected = await page.evaluate(`typeof window.__obcExtractMovements === "function"`) as boolean;
  if (alreadyInjected) return;

  await page.addScriptTag({
    content: `
      window.__obcExtractMovements = function(src) {
        var results = [];

        // Strategy 1: Consorcio <cns-table> with slot="FechaN" pattern
        var cnsTables = document.querySelectorAll("cns-table");
        for (var t = 0; t < cnsTables.length; t++) {
          var table = cnsTables[t];
          for (var i = 0; i < 500; i++) {
            var dateEl = table.querySelector('[slot="Fecha' + i + '"]');
            if (!dateEl) break;
            var descEl = table.querySelector('[slot="Descripci\\u00f3n' + i + '"], [slot="Descripcion' + i + '"], [slot="Detalle' + i + '"], [slot="Comercio' + i + '"]');
            var amountEl = table.querySelector('[slot="Cargo/Abono' + i + '"], [slot="Cargo' + i + '"], [slot="Monto' + i + '"]');
            var balanceEl = table.querySelector('[slot="Saldo' + i + '"]');
            var cuotasEl = table.querySelector('[slot="Cuotas' + i + '"], [slot="Cuota' + i + '"]');

            var date = dateEl ? dateEl.textContent.trim() : "";
            var description = descEl ? descEl.textContent.trim() : "";
            var amountStr = amountEl ? amountEl.textContent.trim() : "";
            var balStr = balanceEl ? balanceEl.textContent.trim() : "";
            var cuotasStr = cuotasEl ? cuotasEl.textContent.trim() : undefined;

            if (!date || !amountStr) continue;

            var clean = amountStr.replace(/[^0-9.,-]/g, "");
            var isNeg = clean.startsWith("-") || amountStr.includes("-$") || amountStr.includes("- $");
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

        // Strategy 2: fallback to standard <table> with <th>/<td>
        if (results.length === 0) {
          var tables = Array.from(document.querySelectorAll("table"));
          for (var tt = 0; tt < tables.length; tt++) {
            var tbl = tables[tt];
            var rows = Array.from(tbl.querySelectorAll("tr"));
            if (rows.length < 2) continue;
            var dateIdx = -1, descIdx = -1, amountIdx = -1, balanceIdx2 = -1, cuotasIdx = -1;
            var hasHeader = false;
            for (var r = 0; r < rows.length; r++) {
              var headers = rows[r].querySelectorAll("th");
              if (headers.length < 2) continue;
              var hTexts = Array.from(headers).map(function(h) { return (h.innerText || "").trim().toLowerCase(); });
              if (!hTexts.some(function(h) { return h.includes("fecha"); })) continue;
              hasHeader = true;
              dateIdx = hTexts.findIndex(function(h) { return h.includes("fecha"); });
              descIdx = hTexts.findIndex(function(h) { return h.includes("descrip") || h.includes("detalle") || h.includes("comercio"); });
              amountIdx = hTexts.findIndex(function(h) { return h.includes("cargo") || h.includes("monto"); });
              balanceIdx2 = hTexts.findIndex(function(h) { return h.includes("saldo"); });
              cuotasIdx = hTexts.findIndex(function(h) { return h.includes("cuota"); });
              break;
            }
            if (!hasHeader) continue;
            for (var r2 = 0; r2 < rows.length; r2++) {
              var cells = rows[r2].querySelectorAll("td");
              if (cells.length < 3) continue;
              var vals = Array.from(cells).map(function(c) { return (c.innerText || "").trim(); });
              var rawDate = dateIdx >= 0 ? (vals[dateIdx] || "") : "";
              if (!/^\\d{1,2}[\\/\\.\\-]\\d{1,2}/.test(rawDate)) continue;
              var desc2 = descIdx >= 0 ? (vals[descIdx] || "") : "";
              var amt = amountIdx >= 0 ? (vals[amountIdx] || "") : "";
              if (!amt) continue;
              var c2 = amt.replace(/[^0-9.,-]/g, "");
              var neg2 = c2.startsWith("-") || amt.includes("-$");
              var n2 = c2.replace(/-/g, "").replace(/\\./g, "").replace(",", ".");
              var a2 = parseInt(n2, 10) || 0;
              if (neg2) a2 = -a2;
              var bs2 = balanceIdx2 >= 0 ? (vals[balanceIdx2] || "") : "";
              var bc2 = bs2.replace(/[^0-9.,-]/g, "");
              var bn2 = bc2.startsWith("-") || bs2.includes("-$");
              var bv2 = bc2.replace(/-/g, "").replace(/\\./g, "").replace(",", ".");
              var b2 = parseInt(bv2, 10) || 0;
              if (bn2) b2 = -b2;
              var cuota2 = cuotasIdx >= 0 ? (vals[cuotasIdx] || "") : undefined;
              if (desc2 || a2 !== 0) {
                results.push({ date: rawDate, description: desc2, amount: a2, balance: b2, source: src, installments: cuota2 || undefined });
              }
            }
          }
        }

        return results;
      };
    `,
  });
}

async function extractMovements(page: Page, source: MovementSource): Promise<BankMovement[]> {
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
// Consorcio uses <cns-paginator> web component with shadow DOM.
// Page buttons are DIV.number inside the shadow root.
// Playwright pierces shadow DOM automatically with CSS locators.

async function paginateAndExtract(page: Page, source: MovementSource, debugLog: string[]): Promise<BankMovement[]> {
  const allMovements: BankMovement[] = [];

  // Extract first page
  const firstPage = await extractMovements(page, source);
  allMovements.push(...firstPage);
  debugLog.push(`    Page 1: ${firstPage.length} movements`);

  // Check if paginator exists (shadow DOM web component)
  const hasPaginator = await page.locator("cns-paginator").isVisible({ timeout: 2000 }).catch(() => false);
  if (!hasPaginator) return allMovements;

  // Get total pages by counting button.pag-btn inside shadow root
  const totalPages = await page.evaluate(() => {
    const paginator = document.querySelector("cns-paginator");
    if (!paginator?.shadowRoot) return 0;
    return paginator.shadowRoot.querySelectorAll("button.pag-btn:not(.btn-with-dots)").length;
  });

  debugLog.push(`    Paginator: ${totalPages} pages detected`);

  for (let pageNum = 2; pageNum <= totalPages && pageNum <= 20; pageNum++) {
    // Click the page button inside the shadow DOM
    const clicked = await page.evaluate((num) => {
      const paginator = document.querySelector("cns-paginator");
      if (!paginator?.shadowRoot) return false;
      const buttons = paginator.shadowRoot.querySelectorAll("button.pag-btn");
      for (const btn of buttons) {
        if (btn.textContent?.trim() === String(num)) {
          (btn as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, pageNum);

    if (!clicked) {
      // Try the forward arrow button (pag-btn--small with SVG)
      const arrowClicked = await page.evaluate(() => {
        const paginator = document.querySelector("cns-paginator");
        if (!paginator?.shadowRoot) return false;
        const arrows = paginator.shadowRoot.querySelectorAll("button.pag-btn--small, button.pag-btn--normal");
        // The last arrow-like button is "next"
        if (arrows.length > 0) {
          const last = arrows[arrows.length - 1] as HTMLElement;
          if (!(last as HTMLButtonElement).disabled) { last.click(); return true; }
        }
        return false;
      });
      if (!arrowClicked) break;
    }

    await waitForNav(page, 1500);

    const pageMovements = await extractMovements(page, source);
    if (pageMovements.length === 0) break;

    allMovements.push(...pageMovements);
    debugLog.push(`    Page ${pageNum}: ${pageMovements.length} movements`);
  }

  return allMovements;
}

// ─── Balance extraction ─────────────────────────────────────────

async function extractBalance(page: Page, debugLog: string[]): Promise<number | undefined> {
  const bodyText = await page.locator("body").textContent().catch(() => "") || "";

  // Consorcio shows "Saldo Disponible\n$263.008" with the amount as a large heading
  const patterns = [
    /Saldo\s+Disponible\s*\$\s*([\d.,]+)/i,
    /Saldo\s+[Dd]isponible\s*\n?\s*\$\s*([\d.,]+)/i,
    /Saldo\s+contable\s*\$?\s*([\d.,]+)/i,
    /Saldo\s+total\s*\$?\s*([\d.,]+)/i,
    /Saldo\s+actual\s*\$?\s*([\d.,]+)/i,
  ];

  for (const pattern of patterns) {
    const m = bodyText.match(pattern);
    if (m) {
      const val = parseChileanAmount(m[1]);
      if (val > 0) {
        debugLog.push(`  Balance: $${m[1]} → ${val}`);
        return val;
      }
    }
  }

  // Targeted fallback: look for the large balance display element
  // Consorcio shows the balance in a prominent element after "Saldo Disponible"
  try {
    const balanceEl = page.locator("text=/^\\$[\\d.,]+$/").first();
    if (await balanceEl.isVisible({ timeout: 1500 }).catch(() => false)) {
      const text = await balanceEl.textContent() || "";
      const cleaned = text.replace(/\$/g, "").trim();
      const val = parseChileanAmount(cleaned);
      if (val > 100) { // Skip tiny "$1" artifacts
        debugLog.push(`  Balance (element): $${cleaned} → ${val}`);
        return val;
      }
    }
  } catch { /* fallback failed */ }

  // Last resort: find first significant $ amount on page (skip small values)
  const amounts = [...bodyText.matchAll(/\$\s*([\d.]{3,15})/g)];
  for (const [, raw] of amounts) {
    const val = parseChileanAmount(raw);
    if (val > 100) {
      debugLog.push(`  Balance (fallback): $${raw} → ${val}`);
      return val;
    }
  }

  debugLog.push("  Balance not found");
  return undefined;
}

// ─── Navigate to Últimos Movimientos ────────────────────────────

async function navigateToMovimientos(page: Page, debugLog: string[], progress: (s: string) => void): Promise<boolean> {
  // From dashboard, click "Saldos y Movimientos" or navigate via menu
  debugLog.push("8. Navigating to Saldos y Movimientos...");
  progress("Navegando a saldos y movimientos...");

  // Try direct text link first (from dashboard)
  let clicked = await clickFirst(page, [
    () => page.getByText("Saldos y Movimientos", { exact: true }).first(),
    () => page.getByRole("link", { name: /Saldos y Movimientos/i }).first(),
  ], SHORT_TIMEOUT);

  if (!clicked) {
    // Try via top menu "Cuentas y Tarjetas"
    await clickFirst(page, [
      () => page.getByText("Cuentas y Tarjetas", { exact: true }).first(),
      () => page.getByRole("link", { name: /Cuentas y Tarjetas/i }).first(),
    ], 3000);
    await delay(800);

    clicked = await clickFirst(page, [
      () => page.getByText("Saldos y Movimientos").first(),
      () => page.getByRole("link", { name: /[Úú]ltimos Movimientos/i }).first(),
    ], SHORT_TIMEOUT);
  }

  if (!clicked) {
    debugLog.push("  Saldos y Movimientos not found");
    return false;
  }

  await waitForNav(page, 2500);
  return true;
}

// ─── Select account from dropdown ───────────────────────────────

async function selectAccount(page: Page, accountIndex: number, debugLog: string[]): Promise<string | undefined> {
  // Consorcio uses a custom dropdown selector
  const selectorClicked = await clickFirst(page, [
    () => page.locator(".cns-selector--container--box").first(),
    () => page.locator("[class*='selector'] > div, [class*='selector'] svg").first(),
  ], 3000);

  if (!selectorClicked) {
    debugLog.push("  Account selector not found");
    return undefined;
  }

  await delay(800);

  // Get account options
  const items = page.locator(".cns-selector--container--box--items > div, [class*='selector'] [class*='items'] > div");
  const count = await items.count().catch(() => 0);

  if (accountIndex >= count) {
    debugLog.push(`  Account index ${accountIndex} out of range (${count} items)`);
    // Close dropdown
    await page.keyboard.press("Escape");
    return undefined;
  }

  // Get the account label before clicking
  const label = await items.nth(accountIndex).textContent().catch(() => "") || "";
  await items.nth(accountIndex).click();
  await waitForNav(page, 2000);

  debugLog.push(`  Selected account: "${label.trim()}"`);
  return label.trim();
}

// ─── Account movements ──────────────────────────────────────────

async function scrapeAccountMovements(
  page: Page,
  debugLog: string[],
  doScreenshots: boolean,
  progress: (s: string) => void,
): Promise<{ movements: BankMovement[]; balance?: number; accountLabel?: string }> {

  const navigated = await navigateToMovimientos(page, debugLog, progress);
  if (!navigated) return { movements: [], balance: undefined };

  await screenshot(page, "06-saldos-page", doScreenshots, debugLog);

  // Select the first account (Cuenta Corriente — index 0 is usually the first)
  const accountLabel = await selectAccount(page, 0, debugLog);
  await screenshot(page, "07-account-selected", doScreenshots, debugLog);

  // Extract balance
  const balance = await extractBalance(page, debugLog);

  // Extract movements with pagination
  progress("Extrayendo movimientos de cuenta...");
  const movements = await paginateAndExtract(page, MOVEMENT_SOURCE.account, debugLog);
  debugLog.push(`9. Account movements: ${movements.length}`);
  progress(`Cuenta: ${movements.length} movimientos`);
  await screenshot(page, "08-account-extracted", doScreenshots, debugLog);

  return { movements: deduplicateMovements(movements), balance, accountLabel };
}

// ─── Línea de Crédito ───────────────────────────────────────────

async function scrapeLineaCredito(
  page: Page,
  debugLog: string[],
  doScreenshots: boolean,
  progress: (s: string) => void,
): Promise<{ movements: BankMovement[]; balance?: number }> {
  debugLog.push("10. Navigating to Línea de Crédito...");
  progress("Navegando a línea de crédito...");

  // We should already be on the Últimos Movimientos page — switch account via selector
  // Línea de Crédito is typically the second account in the dropdown
  const label = await selectAccount(page, 1, debugLog);

  if (!label || !label.toLowerCase().includes("cr")) {
    // If second item isn't Línea de Crédito, try looking for it explicitly
    const selectorClicked = await clickFirst(page, [
      () => page.locator(".cns-selector--container--box").first(),
    ], 2000);

    if (selectorClicked) {
      await delay(800);
      const items = page.locator(".cns-selector--container--box--items > div");
      const count = await items.count().catch(() => 0);

      let found = false;
      for (let i = 0; i < count; i++) {
        const text = await items.nth(i).textContent().catch(() => "") || "";
        if (text.toLowerCase().includes("línea") || text.toLowerCase().includes("linea") || text.toLowerCase().includes("crédito")) {
          await items.nth(i).click();
          await waitForNav(page, 2000);
          found = true;
          debugLog.push(`  Found Línea de Crédito at index ${i}`);
          break;
        }
      }
      if (!found) {
        await page.keyboard.press("Escape");
        debugLog.push("  Línea de Crédito not found in selector");
        return { movements: [], balance: undefined };
      }
    } else {
      debugLog.push("  Could not open account selector for Línea de Crédito");
      return { movements: [], balance: undefined };
    }
  }

  await screenshot(page, "09-linea-credito", doScreenshots, debugLog);

  const balance = await extractBalance(page, debugLog);

  progress("Extrayendo movimientos de línea de crédito...");
  const movements = await paginateAndExtract(page, MOVEMENT_SOURCE.account, debugLog);
  debugLog.push(`  Línea de crédito: ${movements.length} movements`);
  progress(`Línea de crédito: ${movements.length} movimientos`);

  return { movements: deduplicateMovements(movements), balance };
}

// ─── Credit card ────────────────────────────────────────────────

async function scrapeCreditCard(
  page: Page,
  debugLog: string[],
  doScreenshots: boolean,
  progress: (s: string) => void,
): Promise<{ movements: BankMovement[]; creditCards: CreditCardBalance[] }> {
  const allMovements: BankMovement[] = [];
  const creditCards: CreditCardBalance[] = [];

  debugLog.push("11. Navigating to credit card section...");
  progress("Navegando a tarjetas de crédito...");

  // Navigate via menu: "Cuentas y Tarjetas" → "Resumen Tarjeta de Crédito"
  // First try clicking from current page
  let navToTc = await clickFirst(page, [
    () => page.getByText("Resumen Tarjeta de Crédito", { exact: true }),
    () => page.getByRole("link", { name: /Resumen Tarjeta de Cr[eé]dito/i }),
  ], 3000);

  if (!navToTc) {
    // Try via top menu
    await clickFirst(page, [
      () => page.getByText("Cuentas y Tarjetas", { exact: true }).first(),
      () => page.getByRole("link", { name: /Cuentas y Tarjetas/i }).first(),
    ], 3000);
    await delay(800);

    navToTc = await clickFirst(page, [
      () => page.getByText("Resumen Tarjeta de Crédito").first(),
      () => page.getByRole("link", { name: /Resumen.*Tarjeta/i }).first(),
      () => page.locator("a").filter({ hasText: /Tarjeta de Cr[eé]dito/i }).first(),
    ], SHORT_TIMEOUT);
  }

  if (!navToTc) {
    // Try navigating back to dashboard and clicking from there
    await page.goto(BANK_URL, { waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
    await delay(2000);

    // Look for TC section on the dashboard
    navToTc = await clickFirst(page, [
      () => page.getByText("Resumen Tarjeta de Crédito").first(),
      () => page.locator("a").filter({ hasText: /Tarjeta de Cr[eé]dito/i }).first(),
    ], SHORT_TIMEOUT);
  }

  if (!navToTc) {
    debugLog.push("  Credit card section not found");
    return { movements: [], creditCards: [] };
  }

  await waitForNav(page, 3000);
  await screenshot(page, "10-credit-card", doScreenshots, debugLog);

  // Dismiss modals (e.g. "Tarjeta de Crédito Bloqueada" or promo popups)
  for (let i = 0; i < 3; i++) {
    // Try the "Entendido" button first (common in Consorcio modals), then close icon
    const dismissed = await clickFirst(page, [
      () => page.getByRole("button", { name: /Entendido/i }),
      () => page.locator(".cns-modal--content--heading--close--icon > svg").first(),
      () => page.locator("[class*='close-modal'], [class*='close']").first(),
    ], 2000);
    if (!dismissed) break;
    await delay(800);
  }

  // Extract card label — Consorcio shows it in the dropdown selector, e.g. "VISA SIGNATURE ****0123"
  const bodyText = await page.locator("body").textContent().catch(() => "") || "";
  const labelPatterns = [
    /(VISA\s+SIGNATURE[^*\n]*(?:\*{2,4}\d{4})?)/i,
    /(VISA\s+(?:GOLD|PLATINUM|BLACK|CLASSIC|INFINITE)[^*\n]*(?:\*{2,4}\d{4})?)/i,
    /(MASTERCARD\s+(?:BLACK|GOLD|PLATINUM|SIGNATURE|BUSINESS)[^*\n]*(?:\*{2,4}\d{4})?)/i,
    /((?:Visa|Mastercard|MasterCard|Amex|American Express)\s*(?:Business|Gold|Platinum|Black|Classic|Signature|Infinite)?(?:\s*\*{2,4}\d{4})?)/i,
  ];
  let cardLabel = "Tarjeta de Crédito Consorcio";
  for (const p of labelPatterns) {
    const m = bodyText.match(p);
    if (m) { cardLabel = m[1].trim(); break; }
  }
  debugLog.push(`  Card: ${cardLabel}`);

  // Extract cupos
  const cupoDispNacMatch = bodyText.match(/[Cc]upo\s+[Dd]isponible[\s\S]{0,30}?\$\s*([\d.,]+)/);
  const cupoTotalNacMatch = bodyText.match(/[Cc]upo\s+[Tt]otal[\s\S]{0,30}?\$\s*([\d.,]+)/);
  const cupoIntMatch = bodyText.match(/[Ii]nternacional[\s\S]{0,80}?USD\s*([\d.,]+)/);

  const creditCard: CreditCardBalance = {
    label: cardLabel,
    ...(cupoDispNacMatch ? {
      national: {
        total: cupoTotalNacMatch ? parseChileanAmount(cupoTotalNacMatch[1]) : 0,
        used: 0,
        available: parseChileanAmount(cupoDispNacMatch[1]),
      },
    } : {}),
    ...(cupoIntMatch ? {
      international: {
        total: 0,
        used: 0,
        available: parseFloat(cupoIntMatch[1].replace(/\./g, "").replace(",", ".")),
        currency: "USD",
      },
    } : {}),
  };

  // ── Estados de cuenta (billed) ─────────────────────────────
  debugLog.push("12. Scraping estados de cuenta...");
  progress("Extrayendo estados de cuenta...");

  const clickedEstados = await clickFirst(page, [
    () => page.getByText("Estados de cuenta", { exact: true }),
    () => page.getByRole("link", { name: /Estados de cuenta/i }),
    () => page.locator("a, button, [role='tab']").filter({ hasText: /Estados de cuenta/i }).first(),
  ], SHORT_TIMEOUT);

  if (clickedEstados) {
    await waitForNav(page, 2000);
    await screenshot(page, "11-estados-cuenta", doScreenshots, debugLog);

    const billedMovements = await paginateAndExtract(page, MOVEMENT_SOURCE.credit_card_billed, debugLog);
    allMovements.push(...billedMovements);
    debugLog.push(`  Estados de cuenta: ${billedMovements.length} movements`);
  }

  // ── Movimientos no facturados (unbilled) ────────────────────
  debugLog.push("13. Scraping movimientos no facturados...");
  progress("Extrayendo movimientos no facturados...");

  const clickedUnbilled = await clickFirst(page, [
    () => page.getByText("Movimientos no facturados", { exact: true }),
    () => page.getByRole("link", { name: /Movimientos no facturados/i }),
    () => page.locator("a, button, [role='tab']").filter({ hasText: /no facturados/i }).first(),
  ], SHORT_TIMEOUT);

  if (clickedUnbilled) {
    await waitForNav(page, 2000);
    await screenshot(page, "12-no-facturados", doScreenshots, debugLog);

    const unbilledMovements = await paginateAndExtract(page, MOVEMENT_SOURCE.credit_card_unbilled, debugLog);
    allMovements.push(...unbilledMovements);
    debugLog.push(`  No facturados: ${unbilledMovements.length} movements`);
  }

  // ── Internacional ──────────────────────────────────────────
  debugLog.push("14. Scraping movimientos internacionales...");
  progress("Extrayendo movimientos internacionales...");

  const clickedIntl = await clickFirst(page, [
    () => page.getByText("Internacional", { exact: true }),
    () => page.getByRole("link", { name: /Internacional/i }),
    () => page.locator("a, button, [role='tab']").filter({ hasText: /Internacional/i }).first(),
  ], SHORT_TIMEOUT);

  if (clickedIntl) {
    await waitForNav(page, 2000);
    await screenshot(page, "13-internacional", doScreenshots, debugLog);

    const intlMovements = await paginateAndExtract(page, MOVEMENT_SOURCE.credit_card_unbilled, debugLog);
    const tagged = intlMovements.map(m => ({
      ...m,
      description: m.description ? `[USD] ${m.description}` : m.description,
    }));
    allMovements.push(...tagged);
    debugLog.push(`  Internacional: ${intlMovements.length} movements`);
  }

  creditCard.movements = deduplicateMovements(allMovements);
  creditCards.push(creditCard);

  debugLog.push(`15. TC total: ${allMovements.length} movements`);
  progress(`Tarjeta: ${allMovements.length} movimientos`);

  return { movements: allMovements, creditCards };
}

// ─── Logout ─────────────────────────────────────────────────────

async function logout(page: Page, debugLog: string[]): Promise<void> {
  try {
    const clicked = await clickFirst(page, [
      () => page.locator(".row.align-items-center.height-logout > .col-auto > svg").first(),
      () => page.locator(".row.align-items-center.height-logout").first(),
      () => page.locator("[class*='logout']").first(),
      () => page.getByRole("link", { name: /[Cc]errar sesi[oó]n|[Ss]alir/i }),
    ], 3000);
    if (clicked) {
      await delay(2000);
      debugLog.push("  Logout OK");
    }
  } catch { /* best effort */ }
}

// ─── Main ────────────────────────────────────────────────────────

async function scrapeConsorcioPw(options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, saveScreenshots: doScreenshots = false } = options;
  const progress = options.onProgress || (() => {});
  const bank = "consorcio";

  if (!rut || !password) {
    return { success: false, bank, accounts: [], error: "Debes proveer RUT y clave." };
  }

  let browser: Browser | undefined;

  try {
    const session = await launchBrowser(options);
    browser = session.browser;
    const { page, debugLog } = session;

    // ── Login ─────────────────────────────────────────────────
    const loginResult = await login(page, rut, password, debugLog, doScreenshots, progress);
    if (!loginResult.success) {
      return {
        success: false, bank, accounts: [],
        error: loginResult.error, screenshot: loginResult.screenshot,
        debug: debugLog.join("\n"),
      };
    }

    // Validate-only mode: return early after successful login
    const validateResult = await handleValidateOnly(page, bank, options);
    if (validateResult) return validateResult;

    // ── Phase 1: Account movements ────────────────────────────
    const { movements: accountMovements, balance, accountLabel } = await scrapeAccountMovements(page, debugLog, doScreenshots, progress);

    // ── Phase 2: Línea de Crédito ─────────────────────────────
    const linea = await scrapeLineaCredito(page, debugLog, doScreenshots, progress);

    // ── Phase 3: Credit card ──────────────────────────────────
    const { movements: tcMovements, creditCards } = await scrapeCreditCard(page, debugLog, doScreenshots, progress);

    // ── Combine ───────────────────────────────────────────────
    const allAccountMovements = deduplicateMovements([...accountMovements, ...linea.movements]);

    const total = allAccountMovements.length + tcMovements.length;
    debugLog.push(`\n═══ Summary: ${allAccountMovements.length} account + ${tcMovements.length} TC = ${total} total ═══`);
    progress(`Listo — ${total} movimientos totales`);

    await screenshot(page, "15-final", doScreenshots, debugLog);
    const ss = doScreenshots ? (await page.screenshot({ fullPage: true })).toString("base64") : undefined;

    // ── Logout ────────────────────────────────────────────────
    await logout(page, debugLog);

    return {
      success: true,
      bank,
      accounts: [
        { label: accountLabel, balance, movements: accountMovements },
        ...(linea.movements.length > 0 ? [{ label: "Línea de Crédito", balance: linea.balance, movements: linea.movements }] : []),
      ],
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

const consorcio: BankScraper = {
  id: "consorcio",
  name: "Banco Consorcio",
  url: BANK_URL,
  scrape: scrapeConsorcioPw,
};

export default consorcio;
