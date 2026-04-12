import * as fs from "fs";
import * as path from "path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { BankMovement, BankScraper, CreditCardBalance, ScrapeResult, ScraperOptions, MovementSource } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { DebugLog, delay, deduplicateMovements, findChrome, normalizeDate, normalizeInstallments, parseChileanAmount } from "../utils.js";

// ─── Constants ───────────────────────────────────────────────────

const BANK_URL = "https://www.itau.cl/personas";
const MAX_CARTOLA_MONTHS = 6;
const NAV_TIMEOUT = 10000;
const SHORT_TIMEOUT = 5000;

const MONTH_NAMES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

// ─── Browser ─────────────────────────────────────────────────────

async function launchBrowser(options: ScraperOptions): Promise<{ browser: Browser; context: BrowserContext; page: Page; debugLog: string[] }> {
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

/** Wait for navigation to settle after a click */
async function waitForNav(page: Page, ms = 2000): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => {});
  await delay(ms);
}

/** Try clicking the first visible match from multiple locator strategies */
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

/** Compute the last N month names going backwards from current month */
function lastNMonths(n: number): string[] {
  const now = new Date();
  const result: string[] = [];
  for (let i = 1; i <= n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    result.push(MONTH_NAMES[d.getMonth()]);
  }
  return result;
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

  // 1. Navigate to homepage
  debugLog.push("1. Navigating to Itaú homepage...");
  progress("Abriendo sitio de Itaú...");
  await page.goto(BANK_URL, { waitUntil: "networkidle", timeout: 30000 });
  await delay(2000);
  await screenshot(page, "01-homepage", doScreenshots, debugLog);

  // 2. Open "Acceso clientes" dropdown
  debugLog.push("2. Opening Acceso clientes dropdown...");
  progress("Abriendo menú de acceso...");
  const clickedAcceso = await clickFirst(page, [
    () => page.getByRole("button", { name: /Acceso clientes/i }),
    () => page.locator("[data-toggle], [aria-haspopup]").filter({ hasText: /Acceso clientes/i }).first(),
  ], NAV_TIMEOUT);

  if (!clickedAcceso) {
    const ss = (await page.screenshot()).toString("base64");
    return { success: false, error: "No se encontró botón 'Acceso clientes'", screenshot: ss };
  }
  await delay(1500);
  await screenshot(page, "02-dropdown", doScreenshots, debugLog);

  // 3. Click "Personas" in the dropdown
  debugLog.push("3. Clicking 'Personas' link...");
  const clickedPersonas = await clickFirst(page, [
    () => page.getByRole("link", { name: /Personas/i }).filter({ hasText: /^\s*Personas\s*$/ }),
    // Fallback: any link whose href points to the login portal
    () => page.locator("a[href*='login'], a[href*='persona']").filter({ hasText: /Personas/i }).first(),
  ], SHORT_TIMEOUT);

  if (!clickedPersonas) {
    // Last resort: inspect all visible "Personas" links and pick the one pointing to login
    const links = page.locator("a:visible").filter({ hasText: "Personas" });
    const count = await links.count();
    let navigated = false;
    for (let i = 0; i < count; i++) {
      const href = await links.nth(i).getAttribute("href").catch(() => "") || "";
      if (href.includes("login") || href.includes("persona") || href.includes("banco.itau")) {
        await links.nth(i).click();
        navigated = true;
        break;
      }
    }
    if (!navigated) {
      const ss = (await page.screenshot()).toString("base64");
      return { success: false, error: "No se encontró link 'Personas' en dropdown", screenshot: ss };
    }
  }

  await waitForNav(page, 3000);
  await screenshot(page, "03-login-page", doScreenshots, debugLog);

  // Verify we reached the login page
  const url = page.url();
  debugLog.push(`  URL: ${url}`);
  if (!url.includes("login") && !url.includes("banco.itau")) {
    const ss = (await page.screenshot()).toString("base64");
    return { success: false, error: `No se llegó al login. URL: ${url}`, screenshot: ss };
  }

  // 4. Fill RUT — type char by char to avoid paste detection
  debugLog.push("4. Filling RUT...");
  progress("Ingresando RUT...");
  const cleanRut = rut.replace(/[.\-\s]/g, "");
  try {
    const rutField = page.locator("#loginNameID");
    await rutField.click({ timeout: NAV_TIMEOUT });
    await rutField.pressSequentially(cleanRut, { delay: 40 });
  } catch {
    const ss = (await page.screenshot()).toString("base64");
    return { success: false, error: "No se encontró campo de RUT (#loginNameID)", screenshot: ss };
  }
  await delay(300);

  // 5. Fill password — type char by char
  debugLog.push("5. Filling password...");
  progress("Ingresando clave...");
  try {
    const passField = page.locator("#pswdId");
    await passField.click({ timeout: SHORT_TIMEOUT });
    await passField.pressSequentially(password, { delay: 40 });
  } catch {
    const ss = (await page.screenshot()).toString("base64");
    return { success: false, error: "No se encontró campo de contraseña (#pswdId)", screenshot: ss };
  }
  await delay(300);
  await screenshot(page, "04-login-filled", doScreenshots, debugLog);

  // 6. Submit
  debugLog.push("6. Submitting login...");
  progress("Iniciando sesión...");
  try {
    await page.getByRole("button", { name: "Ingresar" }).click({ timeout: SHORT_TIMEOUT });
  } catch {
    // Fallback: any submit-type button
    await page.locator("button[type='submit'], input[type='submit']").first().click();
  }
  await waitForNav(page, 5000);
  await screenshot(page, "05-post-login", doScreenshots, debugLog);

  // ── Post-login checks ──────────────────────────────────────
  const body = await page.locator("body").textContent().catch(() => "") || "";

  // Security block
  if (body.includes("Acceso restringido") || body.includes("Error 15")) {
    const ss = (await page.screenshot()).toString("base64");
    return { success: false, error: "Acceso bloqueado por seguridad del banco (Error 15). Intenta desde un navegador normal primero.", screenshot: ss };
  }

  // Wrong credentials
  const lower = body.toLowerCase();
  if (lower.includes("clave incorrecta") || lower.includes("rut inválido") || lower.includes("datos incorrectos") || lower.includes("cuenta bloqueada") || lower.includes("suspendida")) {
    const ss = (await page.screenshot()).toString("base64");
    return { success: false, error: "Credenciales incorrectas o cuenta bloqueada.", screenshot: ss };
  }

  // 2FA check
  if (lower.includes("clave dinámica") || lower.includes("segundo factor") || lower.includes("itaú key") || lower.includes("verificación")) {
    const timeoutSec = parseInt(process.env.ITAU_2FA_TIMEOUT_SEC || "0", 10);
    if (timeoutSec > 0) {
      debugLog.push(`  2FA detected — waiting up to ${timeoutSec}s...`);
      progress("Esperando aprobación de 2FA...");
      const approved = await page.waitForFunction(() => {
        const t = document.body?.innerText?.toLowerCase() || "";
        return !t.includes("clave dinámica") && !t.includes("segundo factor") && !t.includes("itaú key") && !t.includes("verificación");
      }, { timeout: timeoutSec * 1000 }).then(() => true, () => false);
      if (!approved) {
        const ss = (await page.screenshot()).toString("base64");
        return { success: false, error: "Timeout esperando aprobación de 2FA.", screenshot: ss };
      }
      await delay(3000);
    } else {
      const ss = (await page.screenshot()).toString("base64");
      return { success: false, error: "El banco pide 2FA. Configura ITAU_2FA_TIMEOUT_SEC para esperar.", screenshot: ss };
    }
  }

  // Still on login page?
  if (page.url().includes("/login")) {
    const ss = (await page.screenshot()).toString("base64");
    return { success: false, error: "Login falló — aún en página de login.", screenshot: ss };
  }

  // Dismiss popups/overlays (the checkmark icon from the recording)
  await clickFirst(page, [
    () => page.locator(".icon-itaufonts_full_check"),
    () => page.locator("[class*='close-modal'], [class*='cerrar']").first(),
  ], 3000);
  await delay(1000);

  debugLog.push("7. Login OK ✓");
  progress("Sesión iniciada correctamente");
  return { success: true };
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

// ─── Balance extraction ─────────────────────────────────────────

async function extractBalance(page: Page, debugLog: string[]): Promise<number | undefined> {
  const bodyText = await page.locator("body").textContent().catch(() => "") || "";

  // Itaú shows balances in various formats across pages:
  //   Dashboard: "Saldo contable $ 1.571"  /  "$ 0.000 $ 1.571"
  //   Saldos:    "CLP $1.571 $0 $1.571 $1"
  //   Cartola:   "Saldo inicial $ 1.571" / "Saldo final disponible $ 1.571"
  const patterns = [
    /Saldo\s+final\s+disponible\s*\$\s*([\d.,]+)/i,
    /Saldo\s+final\s*\$\s*([\d.,]+)/i,
    /Saldo\s+disponible\s*\$\s*([\d.,]+)/i,
    /Saldo\s+contable\s*\$\s*([\d.,]+)/i,
    /Saldo\s+inicial\s*\$\s*([\d.,]+)/i,
    /Saldo\s+total\s*\$\s*([\d.,]+)/i,
    /CLP\s*\$\s*([\d.,]+)/i,
  ];

  for (const pattern of patterns) {
    const m = bodyText.match(pattern);
    if (m) {
      const val = parseChileanAmount(m[1]);
      if (val !== 0) {
        debugLog.push(`  Balance: $${m[1]} → ${val}`);
        return val;
      }
    }
  }

  // Fallback: extract all $ amounts and take the first reasonable one
  const amounts = [...bodyText.matchAll(/\$\s*([\d.]{1,15})/g)];
  for (const [, raw] of amounts) {
    const val = parseChileanAmount(raw);
    if (val > 0) {
      debugLog.push(`  Balance (fallback): $${raw} → ${val}`);
      return val;
    }
  }

  debugLog.push("  Balance not found");
  return undefined;
}

// ─── Account movements ──────────────────────────────────────────

async function scrapeAccountMovements(
  page: Page,
  debugLog: string[],
  doScreenshots: boolean,
  progress: (s: string) => void,
): Promise<{ movements: BankMovement[]; balance?: number }> {
  debugLog.push("8. Navigating to Saldos y últimos movimientos...");
  progress("Navegando a saldos y movimientos...");

  // Navigate via menu: "Cuentas" tab → "Saldos y últimos movimientos"
  await clickFirst(page, [
    () => page.locator("#navigationCuentas_li").getByText("Cuentas"),
    () => page.getByRole("link", { name: /^Cuentas$/i }),
  ], SHORT_TIMEOUT);
  await delay(2000);

  const clicked = await clickFirst(page, [
    () => page.getByRole("link", { name: /Saldos y últimos movimientos/i }).first(),
    () => page.locator("a").filter({ hasText: /Saldos y .*ltimos movimientos/i }).first(),
  ], SHORT_TIMEOUT);

  if (clicked) await waitForNav(page);
  await screenshot(page, "06-account-movements", doScreenshots, debugLog);

  // Try different period views for more data
  const periodClicked = await clickFirst(page, [
    () => page.getByRole("listitem").filter({ hasText: "Mes actual" }),
    () => page.getByRole("link", { name: /Últimos 30 movimientos/i }),
    () => page.getByText("Movimientos del día"),
  ], 3000);

  if (periodClicked) await waitForNav(page);

  // Extract balance
  const balance = await extractBalance(page, debugLog);

  // Extract movements
  progress("Extrayendo movimientos de cuenta...");
  const movements = await extractMovements(page, MOVEMENT_SOURCE.account);
  debugLog.push(`9. Account movements: ${movements.length}`);
  progress(`Cuenta: ${movements.length} movimientos`);
  await screenshot(page, "07-account-extracted", doScreenshots, debugLog);

  return { movements: deduplicateMovements(movements), balance };
}

// ─── Cartola Histórica ──────────────────────────────────────────

async function scrapeCartolaHistorica(
  page: Page,
  debugLog: string[],
  doScreenshots: boolean,
  progress: (s: string) => void,
  existingBalance?: number,
): Promise<{ movements: BankMovement[]; balance?: number }> {
  debugLog.push("10. Navigating to Cartola Histórica...");
  progress("Navegando a cartola histórica...");

  const navigated = await clickFirst(page, [
    () => page.getByRole("link", { name: /Cartola Hist[oó]rica/i }).first(),
    () => page.locator("#linkLcCartolaHistorica_a"),
    () => page.locator("a").filter({ hasText: /[Cc]artola/ }).first(),
  ], SHORT_TIMEOUT);

  if (!navigated) {
    debugLog.push("  Cartola Histórica not found, skipping");
    return { movements: [], balance: existingBalance };
  }

  await waitForNav(page, 3000);
  debugLog.push(`  URL: ${page.url()}`);
  await screenshot(page, "08-cartola-historica", doScreenshots, debugLog);

  // Try to extract balance from cartola page (more reliable than dashboard)
  const balance = existingBalance ?? await extractBalance(page, debugLog);

  const allMovements: BankMovement[] = [];

  // Extract current month
  const currentMovements = await extractMovements(page, MOVEMENT_SOURCE.account);
  allMovements.push(...currentMovements);
  debugLog.push(`  Current month: ${currentMovements.length} movements`);

  // Navigate backwards through previous months dynamically
  const monthsToCheck = lastNMonths(MAX_CARTOLA_MONTHS);
  debugLog.push(`  Checking months: ${monthsToCheck.join(", ")}`);

  for (const month of monthsToCheck) {
    try {
      const calendarIcon = page.locator("#calendarIcon");
      if (!await calendarIcon.isVisible({ timeout: 2000 }).catch(() => false)) break;

      await calendarIcon.click();
      await delay(800);

      // Look for the month button in the calendar popup
      const monthBtn = page.getByText(month, { exact: true });
      if (!await monthBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        // Try navigating to previous year
        const prevBtn = page.locator("#pre");
        if (await prevBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await prevBtn.click();
          await delay(800);
          if (!await monthBtn.isVisible({ timeout: 2000 }).catch(() => false)) continue;
        } else {
          continue;
        }
      }

      await monthBtn.click();
      await waitForNav(page, 2000);

      const monthMovements = await extractMovements(page, MOVEMENT_SOURCE.account);
      allMovements.push(...monthMovements);
      debugLog.push(`  ${month}: ${monthMovements.length} movements`);
    } catch {
      debugLog.push(`  ${month}: navigation failed, stopping`);
      break;
    }
  }

  const deduped = deduplicateMovements(allMovements);
  progress(`Cartola histórica: ${deduped.length} movimientos`);
  await screenshot(page, "09-cartola-done", doScreenshots, debugLog);

  return { movements: deduped, balance };
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

  // Navigate to TC section via top menu "Tarjeta de crédito" tab or sidebar
  const navToTc = await clickFirst(page, [
    () => page.getByRole("link", { name: /Tarjeta de cr[eé]dito/i }).first(),
    () => page.locator("a").filter({ hasText: /tarjeta de cr[eé]dito/i }).first(),
  ], SHORT_TIMEOUT);

  if (navToTc) await waitForNav(page);

  // Try "Resumen tarjeta de crédito"
  const hasResumen = await clickFirst(page, [
    () => page.getByRole("link", { name: /Resumen tarjeta de cr[eé]dito/i }),
    () => page.locator("a").filter({ hasText: /[Rr]esumen.*tarjeta/ }).first(),
  ], SHORT_TIMEOUT);

  if (!hasResumen) {
    // Check if this account even has a TC
    const bodyText = await page.locator("body").textContent().catch(() => "") || "";
    if (bodyText.includes("no tienes una tarjeta") || bodyText.includes("no cuentas con tarjeta") || bodyText.includes("sin tarjeta")) {
      debugLog.push("  No credit card on this account");
      return { movements: [], creditCards: [] };
    }
    debugLog.push("  Credit card section not found");
    return { movements: [], creditCards: [] };
  }

  await waitForNav(page, 4000);
  await screenshot(page, "10-credit-card", doScreenshots, debugLog);

  // Extract card label — Itaú shows "Mastercard Business", "Visa Gold ****1234", etc.
  const bodyText = await page.locator("body").textContent().catch(() => "") || "";
  const labelPatterns = [
    /((?:Visa|Mastercard|MasterCard|Amex|American Express)\s*(?:Business|Gold|Platinum|Black|Classic|Signature)?(?:\s*\*{2,4}\d{4})?)/i,
  ];
  let cardLabel = "Tarjeta de Crédito Itaú";
  for (const p of labelPatterns) {
    const m = bodyText.match(p);
    if (m) { cardLabel = m[1].trim(); break; }
  }
  debugLog.push(`  Card: ${cardLabel}`);

  // Extract cupos (credit limits) — Nacional and Internacional sections
  const cupoDispNacMatch = bodyText.match(/[Cc]upo\s+[Dd]isponible[\s\S]{0,30}?\$\s*([\d.,]+)/);
  const cupoTotalNacMatch = bodyText.match(/[Cc]upo\s+[Rr]epactado[\s\S]{0,30}?\$\s*([\d.,]+)/)
    || bodyText.match(/[Cc]upo\s+[Tt]otal[\s\S]{0,30}?\$\s*([\d.,]+)/);

  // International cupo — look for USD pattern
  const cupoIntMatch = bodyText.match(/[Ii]nternacional[\s\S]{0,80}?USD\s*([\d.,]+)/);
  const cupoIntDispMatch = bodyText.match(/[Ii]nternacional[\s\S]{0,80}?[Dd]isponible[\s\S]{0,30}?USD\s*([\d.,]+)/);

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
        available: cupoIntDispMatch ? parseFloat(cupoIntDispMatch[1].replace(/\./g, "").replace(",", ".")) : 0,
        currency: "USD",
      },
    } : {}),
  };

  // ── CLP movements (unbilled) ──────────────────────────────
  debugLog.push("12. Scraping TC movements in CLP...");
  progress("Extrayendo movimientos TC en pesos...");

  await clickFirst(page, [
    () => page.getByRole("link", { name: /[Úú]ltimos movimientos en pesos/i }),
    () => page.locator("a").filter({ hasText: /movimientos.*pesos/i }).first(),
  ], SHORT_TIMEOUT);
  await waitForNav(page);
  await screenshot(page, "11-tc-pesos", doScreenshots, debugLog);

  const pesoMovements = await extractMovements(page, MOVEMENT_SOURCE.credit_card_unbilled);
  allMovements.push(...pesoMovements);
  debugLog.push(`  TC CLP: ${pesoMovements.length} movements`);

  // ── USD movements ─────────────────────────────────────────
  debugLog.push("13. Scraping TC movements in USD...");
  progress("Extrayendo movimientos TC en dólares...");

  const clickedUsd = await clickFirst(page, [
    () => page.locator("#linkRtUltimosMovsDolares_a"),
    () => page.getByRole("link", { name: /movimientos.*d[oó]lares/i }),
    () => page.locator("a").filter({ hasText: /d[oó]lares/i }).first(),
  ], SHORT_TIMEOUT);

  if (clickedUsd) {
    await waitForNav(page);
    await screenshot(page, "12-tc-dolares", doScreenshots, debugLog);

    const usdMovements = await extractMovements(page, MOVEMENT_SOURCE.credit_card_unbilled);
    // Tag USD movements to differentiate
    const tagged = usdMovements.map(m => ({
      ...m,
      description: m.description ? `[USD] ${m.description}` : m.description,
    }));
    allMovements.push(...tagged);
    debugLog.push(`  TC USD: ${usdMovements.length} movements`);
  } else {
    debugLog.push("  TC USD section not found");
  }

  creditCard.movements = deduplicateMovements(allMovements);
  creditCards.push(creditCard);

  debugLog.push(`14. TC total: ${allMovements.length} movements`);
  progress(`Tarjeta: ${allMovements.length} movimientos`);

  return { movements: allMovements, creditCards };
}

// ─── Logout ─────────────────────────────────────────────────────

async function logout(page: Page, debugLog: string[]): Promise<void> {
  try {
    const clicked = await clickFirst(page, [
      () => page.getByRole("link", { name: /Cerrar sesión/i }),
      () => page.locator("a, button").filter({ hasText: /[Cc]errar sesi[oó]n/i }).first(),
    ], 3000);
    if (clicked) {
      await delay(2000);
      debugLog.push("  Logout OK");
    }
  } catch { /* best effort — browser.close() cleans up anyway */ }
}

// ─── Main ────────────────────────────────────────────────────────

async function scrapeItauPw(options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, saveScreenshots: doScreenshots = false } = options;
  const progress = options.onProgress || (() => {});
  const bank = "itau";

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

    // ── Phase 1: Account movements ────────────────────────────
    const { movements: accountMovements, balance } = await scrapeAccountMovements(page, debugLog, doScreenshots, progress);

    // ── Phase 2: Cartola histórica ────────────────────────────
    const cartola = await scrapeCartolaHistorica(page, debugLog, doScreenshots, progress, balance);

    // Use cartola balance if account page didn't find one
    const finalBalance = balance ?? cartola.balance;

    // Combine and deduplicate
    const allAccountMovements = deduplicateMovements([...accountMovements, ...cartola.movements]);

    // ── Phase 3: Credit card ──────────────────────────────────
    const { movements: tcMovements, creditCards } = await scrapeCreditCard(page, debugLog, doScreenshots, progress);

    // ── Summary ───────────────────────────────────────────────
    const total = allAccountMovements.length + tcMovements.length;
    debugLog.push(`\n═══ Summary: ${allAccountMovements.length} account + ${tcMovements.length} TC = ${total} total ═══`);
    progress(`Listo — ${total} movimientos totales`);

    await screenshot(page, "13-final", doScreenshots, debugLog);
    const ss = doScreenshots ? (await page.screenshot({ fullPage: true })).toString("base64") : undefined;

    // ── Logout ────────────────────────────────────────────────
    await logout(page, debugLog);

    return {
      success: true,
      bank,
      accounts: [{ balance: finalBalance, movements: allAccountMovements }],
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

const itau: BankScraper = {
  id: "itau",
  name: "Itaú",
  url: BANK_URL,
  scrape: scrapeItauPw,
};

export default itau;
