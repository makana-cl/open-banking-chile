import type { Page } from "puppeteer-core";
import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { deduplicateMovements, closePopups, delay, normalizeDate, parseChileanAmount } from "../utils.js";
import { createInterceptor } from "../intercept.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";

// ─── API response normalizers ────────────────────────────────────

interface SantanderCheckingApiMovement {
  transactionDate: string; // "2026-03-19"
  movementAmount: string; // "00000010000000-" (centavos, trailing - = debit)
  chargePaymentFlag: string; // "D" = debit, "H" = haber/credit
  observation: string;
  expandedCode: string;
  newBalance?: string;
}

export function normalizeSantanderCheckingApiMovements(captures: unknown[]): BankMovement[] {
  const movements: BankMovement[] = [];
  for (const capture of captures) {
    const obj = capture as { movements?: SantanderCheckingApiMovement[] };
    const list = obj?.movements;
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      const digits = m.movementAmount.replace(/[^0-9]/g, "");
      const raw = parseInt(digits, 10);
      if (!raw || isNaN(raw)) continue;
      const clp = raw / 100;
      const isDebit = m.chargePaymentFlag === "D" || m.movementAmount.endsWith("-");
      const amount = isDebit ? -clp : clp;
      const description = (m.observation?.trim() || m.expandedCode?.trim() || "").trim();
      let balance = 0;
      if (m.newBalance) {
        const balDigits = m.newBalance.replace(/[^0-9]/g, "");
        balance = Math.round(parseInt(balDigits, 10) / 100);
      }
      movements.push({
        date: normalizeDate(m.transactionDate),
        description,
        amount,
        balance,
        source: MOVEMENT_SOURCE.account,
      });
    }
  }
  return movements;
}

interface SantanderCcApiMovement {
  Fecha: string;
  Comercio: string;
  Descripcion: string;
  Importe: string;
  IndicadorDebeHaber: string;
}

function isSaldoInicial(description: string): boolean {
  return /saldo\s+inicial/i.test(description);
}

export function normalizeSantanderUnbilledApiMovements(captures: unknown[]): BankMovement[] {
  const movements: BankMovement[] = [];
  for (const capture of captures) {
    const obj = capture as { DATA?: { MatrizMovimientos?: SantanderCcApiMovement[] } };
    const list = obj?.DATA?.MatrizMovimientos;
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      const raw = parseChileanAmount(m.Importe);
      if (!raw || isNaN(raw)) continue;
      const isDebit = m.IndicadorDebeHaber === "D";
      const amount = isDebit ? -raw : raw;
      const description = (m.Comercio?.trim() || m.Descripcion?.trim() || "").trim();
      if (isSaldoInicial(description)) continue;
      movements.push({
        date: normalizeDate(m.Fecha),
        description,
        amount,
        balance: 0,
        source: MOVEMENT_SOURCE.credit_card_unbilled,
      });
    }
  }
  return movements;
}

interface SantanderBilledApiMovement {
  FechaTxs: string;
  NombreComercio: string;
  MontoTxs: string;
  NumeroCuotas: string;
  TotalCuotas: string;
}

export function normalizeSantanderBilledApiMovements(captures: unknown[]): BankMovement[] {
  const movements: BankMovement[] = [];
  for (const capture of captures) {
    const path = (capture as Record<string, unknown>)?.DATA as Record<string, unknown> | undefined;
    const response = path?.AS_TIB_WM02_CONEstCtaNacional_Response as
      | Record<string, unknown>
      | undefined;
    const output = response?.OUTPUT as Record<string, unknown> | undefined;
    const list = output?.Matriz as SantanderBilledApiMovement[] | undefined;
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      const cleaned = m.MontoTxs.replace(/^0+/, "").replace(/\./g, "") || "0";
      const raw = parseInt(cleaned, 10);
      if (!raw || isNaN(raw)) continue;
      if (isSaldoInicial(m.NombreComercio)) continue;
      const isPayment = m.NombreComercio.toLowerCase().includes("monto cancelado");
      const amount = isPayment ? raw : -raw;
      const totalCuotas = parseInt(m.TotalCuotas.replace(/^0+/, "") || "0", 10);
      const currentCuota = parseInt(m.NumeroCuotas.replace(/^0+/, "") || "0", 10);
      const installments =
        totalCuotas > 0
          ? `${String(currentCuota).padStart(2, "0")}/${String(totalCuotas).padStart(2, "0")}`
          : undefined;
      movements.push({
        date: normalizeDate(m.FechaTxs),
        description: m.NombreComercio,
        amount,
        balance: 0,
        source: MOVEMENT_SOURCE.credit_card_billed,
        ...(installments ? { installments } : {}),
      });
    }
  }
  return movements;
}

// ─── Date helpers ────────────────────────────────────────────────────

/** Converts any date format to DD-MM-YYYY. Handles YYYY-MM-DD from API and DD/MM/YYYY from DOM. */
function toDateDMY(raw: string): string {
  const t = raw.trim();
  // YYYY-MM-DD → DD-MM-YYYY
  const isoMatch = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return `${isoMatch[3]}-${isoMatch[2]}-${isoMatch[1]}`;
  // Already DD-MM-YYYY
  if (/^\d{2}-\d{2}-\d{4}$/.test(t)) return t;
  // DD/MM/YYYY or DD.MM.YYYY → DD-MM-YYYY
  return normalizeDate(t);
}

/** Keywords that indicate a credit (positive amount) in CC movements */
const CREDIT_KEYWORDS = ["pago", "abono", "monto cancelado", "devolucion", "devolución", "reversa", "nota de credito", "nota de crédito"];

function isCreditDescription(desc: string): boolean {
  const lower = desc.toLowerCase();
  return CREDIT_KEYWORDS.some((kw) => lower.includes(kw));
}

// ─── Constants ───────────────────────────────────────────────────────

const BANK_URL = "https://mibanco.santander.cl";

// API endpoints — the new portal may use the same backend APIs
const API_CHECKING =
  "https://openbanking.santander.cl/account_balances_transactions_and_withholdings_retail/v1/current-accounts/transactions";
const API_CC_UNBILLED =
  "https://api-dsk.santander.cl/perdsk/tarjetasDeCredito/consultaUltimosMovimientos";
const API_CC_BILLED =
  "https://api-dsk.santander.cl/perdsk/tarjetasDeCredito/estadoCuentaNacional";

// ─── Puppeteer helpers (getByRole/getByText equivalents) ─────────────

/** Finds and clicks the first visible element matching a text pattern */
async function clickText(page: Page, text: string, options?: { exact?: boolean; timeout?: number }): Promise<boolean> {
  const timeout = options?.timeout ?? 5000;
  const exact = options?.exact ?? false;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const clicked = await page.evaluate(
      (searchText: string, isExact: boolean) => {
        const elements = Array.from(
          document.querySelectorAll("a, button, span, div, li, mat-option, h2, h3, p, label, tab, [role='tab'], [role='button']"),
        );
        for (const el of elements) {
          const htmlEl = el as HTMLElement;
          if (!htmlEl.offsetParent && htmlEl.style.display !== "fixed") continue; // not visible
          const elText = htmlEl.innerText?.trim() || "";
          const match = isExact ? elText === searchText : elText.toLowerCase().includes(searchText.toLowerCase());
          if (match) {
            htmlEl.click();
            return true;
          }
        }
        return false;
      },
      text,
      exact,
    );
    if (clicked) return true;
    await delay(300);
  }
  return false;
}

/** Finds and clicks a button by its accessible name or text content */
async function clickButton(page: Page, name: string, options?: { timeout?: number }): Promise<boolean> {
  const timeout = options?.timeout ?? 5000;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const clicked = await page.evaluate((searchName: string) => {
      const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
      for (const btn of buttons) {
        const htmlBtn = btn as HTMLElement;
        const ariaLabel = btn.getAttribute("aria-label") || "";
        const text = htmlBtn.innerText?.trim() || "";
        if (
          text.toLowerCase().includes(searchName.toLowerCase()) ||
          ariaLabel.toLowerCase().includes(searchName.toLowerCase())
        ) {
          htmlBtn.click();
          return true;
        }
      }
      return false;
    }, name);
    if (clicked) return true;
    await delay(300);
  }
  return false;
}

/** Finds and clicks a tab by its name */
async function clickTab(page: Page, name: string, options?: { timeout?: number }): Promise<boolean> {
  const timeout = options?.timeout ?? 5000;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const clicked = await page.evaluate((searchName: string) => {
      const tabs = Array.from(document.querySelectorAll("[role='tab'], .mat-tab-label, .mat-mdc-tab"));
      for (const tab of tabs) {
        const htmlTab = tab as HTMLElement;
        const text = htmlTab.innerText?.trim() || "";
        if (text.toLowerCase().includes(searchName.toLowerCase())) {
          htmlTab.click();
          return true;
        }
      }
      return false;
    }, name);
    if (clicked) return true;
    await delay(300);
  }
  return false;
}

/** Fills a textbox identified by placeholder or aria-label using real keystrokes */
async function fillInput(page: Page, label: string, value: string): Promise<boolean> {
  // Find the input's index
  const index = await page.evaluate((searchLabel: string) => {
    const inputs = Array.from(document.querySelectorAll("input, textarea"));
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i] as HTMLInputElement;
      const placeholder = input.placeholder || "";
      const ariaLabel = input.getAttribute("aria-label") || "";
      const id = input.id || "";
      if (
        placeholder.toLowerCase().includes(searchLabel.toLowerCase()) ||
        ariaLabel.toLowerCase().includes(searchLabel.toLowerCase()) ||
        id.toLowerCase().includes(searchLabel.toLowerCase())
      ) {
        return i;
      }
    }
    return -1;
  }, label);

  if (index === -1) return false;

  const inputs = await page.$$("input, textarea");
  const input = inputs[index];
  if (!input) return false;

  // Click to focus
  await input.click();
  await delay(300);
  // Select all and clear
  await input.click({ clickCount: 3 });
  await delay(100);
  await page.keyboard.press("Backspace");
  await delay(200);
  // Type character by character — Angular reactive forms need real key events
  await input.type(value, { delay: 50 });
  await delay(300);
  return true;
}

/** Waits for a text to appear on the page */
async function waitForText(page: Page, text: string, timeout = 15000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await page.evaluate((searchText: string) => {
      return document.body?.innerText?.toLowerCase().includes(searchText.toLowerCase()) ?? false;
    }, text);
    if (found) return true;
    await delay(500);
  }
  return false;
}

/**
 * Extracts movements from the visible DOM.
 * The new Santander portal renders movements as rows with date, description, and amount cells.
 * Dollar amounts may be in USD format (e.g., "USD 5,99" or "5.99").
 */
async function extractMovementsFromDOM(page: Page, source: string, creditKeywords: string[]): Promise<BankMovement[]> {
  return page.evaluate((movementSource: string, creditKws: string[]) => {
    const movements: Array<{
      date: string;
      description: string;
      amount: number;
      balance: number;
      source: string;
    }> = [];

    // Date pattern: dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy (with 2 or 4 digit year)
    const isDate = (t: string) => /^\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}$/.test(t.trim());

    // Amount pattern: "$1.234", "-$50.000", "USD 5,99", "5.99", "-1.234"
    // Must NOT match dates — dates have exactly 2 separators (dd/mm/yyyy)
    const parseAmount = (t: string): number | null => {
      if (!t || isDate(t)) return null;
      const clean = t.replace(/USD\s*/i, "").replace(/CLP\s*/i, "").trim();
      if (!clean) return null;
      const isNeg = clean.startsWith("-") || t.includes("-$") || t.includes("- $");
      // Remove currency symbols, spaces
      const digits = clean.replace(/[^0-9.,-]/g, "");
      if (!digits || digits.length === 0) return null;
      // Chilean format: 1.234.567 (dots as thousands), or USD format: 5.99 (dot as decimal)
      // If there's a comma, it's likely a decimal separator (USD): "5,99" → 5.99
      let normalized: string;
      if (digits.includes(",")) {
        // "1.234,56" → remove dots (thousands), replace comma with dot
        normalized = digits.replace(/\./g, "").replace(",", ".");
      } else {
        // "1.234.567" — all dots are thousands separators
        // "5.99" — single dot could be decimal
        const dotCount = (digits.match(/\./g) || []).length;
        if (dotCount === 1 && digits.split(".")[1]?.length === 2) {
          // Likely decimal: "5.99" or "123.45"
          normalized = digits;
        } else {
          // Thousands: "1.234" or "1.234.567"
          normalized = digits.replace(/\./g, "");
        }
      }
      normalized = normalized.replace(/-/g, "");
      const val = parseFloat(normalized);
      if (isNaN(val) || val === 0) return null;
      // Round to integer for CLP, keep decimals for USD
      const amount = Math.round(val);
      return isNeg ? -amount : amount;
    };

    // Look for table rows or repeated movement patterns
    const rows = Array.from(
      document.querySelectorAll(
        "table tbody tr, .movement-row, .movimiento, " +
        "[class*='movement'], [class*='movimiento'], " +
        "[class*='transaction'], [class*='row-data']",
      ),
    );

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td, .cell, span, div"));
      const texts = cells
        .map((c) => (c as HTMLElement).innerText?.trim())
        .filter((t) => t && t.length > 0);

      if (texts.length < 2) continue;

      // Find date, then description, then amount — in order
      const datePart = texts.find((t) => isDate(t));
      if (!datePart) continue;

      // Everything that's not the date and not parseable as amount is description
      const remaining = texts.filter((t) => t !== datePart);
      let amount: number | null = null;
      const descParts: string[] = [];

      // First pass: find amounts (check from the end — amounts are usually last)
      for (let ri = remaining.length - 1; ri >= 0; ri--) {
        const t = remaining[ri];
        if (amount !== null) {
          // Already found amount, rest is description
          if (t.length > 2) descParts.unshift(t);
          continue;
        }
        const parsed = parseAmount(t);
        if (parsed !== null) {
          amount = parsed;
        } else if (t.length > 2) {
          descParts.unshift(t);
        }
      }

      const description = descParts.join(" ").trim();
      if (!description) continue;

      // Normalize date separators to DD-MM-YYYY
      const normalizedDate = datePart.replace(/\//g, "-").replace(/\./g, "-");

      // For credit card movements: default to negative (debit) unless
      // the description indicates a credit (payment, refund, etc.)
      let finalAmount = amount ?? 0;
      if (
        finalAmount !== 0 &&
        (movementSource === "credit_card_unbilled" || movementSource === "credit_card_billed")
      ) {
        const isCredit = creditKws.some((kw) => description.toLowerCase().includes(kw));
        // If amount has no explicit sign from DOM, make it negative for debits
        if (finalAmount > 0 && !isCredit) {
          finalAmount = -finalAmount;
        }
      }

      movements.push({
        date: normalizedDate,
        description,
        amount: finalAmount,
        balance: 0,
        source: movementSource,
      });
    }

    return movements;
  }, source, creditKeywords) as Promise<BankMovement[]>;
}

/**
 * Clicks the "Pesos" or "Dólares" currency toggle button in the TC movements area.
 * Must NOT match sidebar items like "Pago en Pesos" / "Pago en dólares".
 */
async function clickCurrencyToggle(page: Page, currency: "Pesos" | "Dólares"): Promise<boolean> {
  return page.evaluate((target: string) => {
    // Look for buttons/tabs that are EXACTLY the currency name, or part of a toggle group
    // Avoid sidebar items (x < 300) and items with "Pago" in text
    const candidates = Array.from(document.querySelectorAll("button, [role='tab'], [role='button'], .mat-button-toggle, a"));
    for (const el of candidates) {
      const htmlEl = el as HTMLElement;
      const text = htmlEl.innerText?.trim() || "";
      const rect = htmlEl.getBoundingClientRect();
      // Must be: exact match or "Pesos" / "Dólares" only, in the main content area (x > 300),
      // not contain "Pago" (sidebar payment items)
      if (
        (text === target || text.toLowerCase() === target.toLowerCase()) &&
        rect.x > 250 &&
        rect.width > 0 &&
        !text.toLowerCase().includes("pago")
      ) {
        htmlEl.click();
        return true;
      }
    }
    return false;
  }, currency);
}

/** Selects a billing period from an Angular mat-select dropdown */
async function selectBillingPeriod(page: Page, index: number): Promise<boolean> {
  // Click the mat-select to open the dropdown
  const opened = await page.evaluate(() => {
    const select = document.querySelector("[class*='mat-select'], mat-select, #mat-select-value-1");
    if (select) {
      (select as HTMLElement).click();
      return true;
    }
    return false;
  });

  if (!opened) return false;
  await delay(800);

  // Click the option at the given index
  const selected = await page.evaluate((optIndex: number) => {
    const options = Array.from(document.querySelectorAll("mat-option, [role='option']"));
    if (options[optIndex]) {
      (options[optIndex] as HTMLElement).click();
      return true;
    }
    return false;
  }, index);

  await delay(1500);
  return selected;
}

/** Lists available billing periods from a mat-select dropdown */
async function listBillingPeriods(page: Page): Promise<string[]> {
  // Open the dropdown
  await page.evaluate(() => {
    const select = document.querySelector("[class*='mat-select'], mat-select, #mat-select-value-1");
    if (select) (select as HTMLElement).click();
  });
  await delay(800);

  const periods = await page.evaluate(() => {
    const options = Array.from(document.querySelectorAll("mat-option, [role='option']"));
    const texts = options.map((o) => (o as HTMLElement).innerText?.trim()).filter(Boolean);
    // Close without selecting
    document.body.click();
    return texts;
  });

  await delay(500);
  return periods;
}

// ─── Main scrape function ────────────────────────────────────────────

async function scrapeSantanderV2(
  session: BrowserSession,
  options: ScraperOptions,
): Promise<ScrapeResult> {
  const { rut, password, saveScreenshots: doScreenshots, onProgress } = options;
  const { page, debugLog, screenshot: doSave } = session;
  const bank = "santander";
  const progress = onProgress || (() => {});

  // Install API interceptors before navigating
  const interceptor = await createInterceptor(page, [
    { id: "checking", urlPrefix: API_CHECKING },
    { id: "cc-unbilled", urlPrefix: API_CC_UNBILLED },
    { id: "cc-billed", urlPrefix: API_CC_BILLED },
  ]);

  // ── 1. Navigate to portal ──────────────────────────────────────
  debugLog.push("1. Navigating to Mi Banco Santander...");
  progress("Abriendo Mi Banco Santander...");
  await page.goto(BANK_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(3000);
  await doSave(page, "01-homepage");

  // ── 2. Login ───────────────────────────────────────────────────
  debugLog.push("2. Filling login credentials...");
  progress("Ingresando credenciales...");

  // Wait for the login form to load
  const loginReady = await waitForText(page, "ingresa tu rut", 15000);
  if (!loginReady) {
    // Try waiting for input fields directly
    try {
      await page.waitForSelector("input", { timeout: 10000 });
    } catch {
      const ss = await page.screenshot({ encoding: "base64" });
      return {
        success: false,
        bank,
        accounts: [],
        error: "No cargó el formulario de login.",
        screenshot: ss as string,
        debug: debugLog.join("\n"),
      };
    }
  }

  await doSave(page, "02-login-form");

  // Fill RUT — the new portal expects RUT with dash but NO dots (e.g. "12345678-9")
  const cleanRut = rut.replace(/\./g, ""); // strip dots, keep dash
  const rutFilled =
    (await fillInput(page, "rut", cleanRut)) ||
    (await fillInput(page, "RUT", cleanRut));
  if (!rutFilled) {
    const ss = await page.screenshot({ encoding: "base64" });
    return {
      success: false,
      bank,
      accounts: [],
      error: "No se encontró el campo de RUT.",
      screenshot: ss as string,
      debug: debugLog.join("\n"),
    };
  }
  debugLog.push("  RUT filled");
  await delay(1000);

  // Fill password
  const passFilled =
    (await fillInput(page, "clave", password)) ||
    (await fillInput(page, "pass", password)) ||
    (await fillInput(page, "password", password));
  if (!passFilled) {
    const ss = await page.screenshot({ encoding: "base64" });
    return {
      success: false,
      bank,
      accounts: [],
      error: "No se encontró el campo de clave.",
      screenshot: ss as string,
      debug: debugLog.join("\n"),
    };
  }
  debugLog.push("  Password filled");
  await delay(500);

  // Click INGRESAR — use Puppeteer's native click on the actual button element
  progress("Iniciando sesión...");
  await delay(500);

  // Try multiple strategies to click the login button
  let loginClicked = false;

  // Strategy 1: Find button by text using Puppeteer $$ and native click
  const allButtons = await page.$$("button");
  for (const btn of allButtons) {
    const text = await btn.evaluate((el) => el.textContent?.trim() || "");
    if (text.toUpperCase().includes("INGRESAR")) {
      await btn.click();
      loginClicked = true;
      debugLog.push("  Login button clicked (native)");
      break;
    }
  }

  // Strategy 2: Enter key from password field
  if (!loginClicked) {
    debugLog.push("  Login button not found, pressing Enter...");
    await page.keyboard.press("Enter");
    loginClicked = true;
  }

  await delay(10000);
  await doSave(page, "03-post-login");

  // Check for login errors — the new portal shows a modal with "Alguno de los datos ingresados es incorrecto"
  const hasError = await page.evaluate(() => {
    const body = document.body?.innerText?.toLowerCase() || "";
    return (
      body.includes("datos ingresados es incorrecto") ||
      body.includes("clave incorrecta") ||
      body.includes("datos incorrectos") ||
      body.includes("rut o clave") ||
      body.includes("no válido") ||
      body.includes("bloqueada") ||
      body.includes("intenta nuevamente") ||
      body.includes("alguno de los datos")
    );
  });

  if (hasError) {
    const errorText = await page.evaluate(() => {
      // The new portal uses a modal/dialog for errors
      const candidates = Array.from(
        document.querySelectorAll(
          "[class*='error'], [class*='alert'], [role='alert'], [role='dialog'], " +
          ".snack-bar-container, .mat-dialog-content, .cdk-overlay-container, " +
          "[class*='modal'], [class*='popup']",
        ),
      );
      for (const el of candidates) {
        const text = (el as HTMLElement).innerText?.trim();
        if (text && text.length > 5 && text.length < 200) return text;
      }
      return "Credenciales incorrectas";
    });
    const ss = await page.screenshot({ encoding: "base64" });
    return {
      success: false,
      bank,
      accounts: [],
      error: `Error del banco: ${errorText}`,
      screenshot: ss as string,
      debug: debugLog.join("\n"),
    };
  }

  // Check if we're still on the login page (login failed silently or page reset)
  const stillOnLogin = await page.evaluate(() => {
    const url = window.location.href.toLowerCase();
    const body = document.body?.innerText?.toLowerCase() || "";
    return (
      url.includes("/login") ||
      url.includes("/public/login") ||
      (body.includes("ingresa tu rut") && body.includes("ingresa tu clave"))
    );
  });

  if (stillOnLogin) {
    debugLog.push("  Still on login page — credentials may be wrong or login button didn't fire");
    const ss = await page.screenshot({ encoding: "base64" });
    return {
      success: false,
      bank,
      accounts: [],
      error: "Login fallido — seguimos en la página de login. Verifica RUT y clave.",
      screenshot: ss as string,
      debug: debugLog.join("\n"),
    };
  }

  // Wait for dashboard to load — look for typical post-login indicators
  const dashboardLoaded = await waitForText(page, "movimientos", 20000) ||
    await waitForText(page, "mis cuentas", 20000) ||
    await waitForText(page, "saldo", 20000);

  if (!dashboardLoaded) {
    // Could be 2FA — check for approval request
    const is2FA = await page.evaluate(() => {
      const body = document.body?.innerText?.toLowerCase() || "";
      return (
        body.includes("aprobar") ||
        body.includes("autorizar") ||
        body.includes("confirmar en tu") ||
        body.includes("superkey") ||
        body.includes("clave dinámica") ||
        body.includes("segundo factor")
      );
    });

    if (is2FA) {
      debugLog.push("  2FA detected — waiting for approval...");
      progress("Esperando aprobación de 2FA...");
      const timeoutSec = parseInt(process.env.SANTANDER_2FA_TIMEOUT_SEC || "120", 10);
      const approved =
        (await waitForText(page, "movimientos", timeoutSec * 1000)) ||
        (await waitForText(page, "mis cuentas", timeoutSec * 1000));
      if (!approved) {
        const ss = await page.screenshot({ encoding: "base64" });
        return {
          success: false,
          bank,
          accounts: [],
          error: "Timeout esperando aprobación de 2FA.",
          screenshot: ss as string,
          debug: debugLog.join("\n"),
        };
      }
      debugLog.push("  2FA approved");
    }
  }

  debugLog.push("3. Login OK — dashboard loaded");
  progress("Sesión iniciada correctamente");
  await closePopups(page);
  await delay(2000);

  let allMovements: BankMovement[] = [];

  // ── 3. Navigate to account movements ───────────────────────────
  // The sidebar has links under "Cuentas" submenu. Clicking account cards on the
  // dashboard navigates AWAY from Santander (to partner banks), so avoid that.
  // Best approach: use Angular SPA sidebar links which are <a> tags with routerLink.
  debugLog.push("4. Navigating to account movements...");
  progress("Navegando a movimientos de cuenta...");

  // Strategy 1: Sidebar → expand "Cuentas" → click "Movimientos" link
  // Angular Material sidebar items use <a> with routerLink. Regular click() on the
  // element may not trigger Angular's router. We try multiple dispatch methods.
  let accountNavOk = false;

  // Expand "Cuentas" submenu
  await clickButton(page, "Cuentas", { timeout: 3000 });
  await delay(1500);

  // Click "Movimientos" in sidebar using multiple strategies
  const movLinkClicked = await page.evaluate(() => {
    // Strategy A: Find sidebar <a> and dispatch a proper MouseEvent + click
    const candidates = Array.from(document.querySelectorAll(
      "nav a, [class*='sidebar'] a, [class*='menu'] a, [class*='nav'] a, " +
      "mat-nav-list a, .mat-list-item, a[routerlink], a[href]",
    ));
    for (const el of candidates) {
      const text = (el as HTMLElement).innerText?.trim();
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (text === "Movimientos" && rect.x < 350 && rect.width > 0) {
        // Dispatch full mouse event sequence (Angular listens to these)
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        return "sidebar-mousevent";
      }
    }
    return null;
  });

  if (movLinkClicked) {
    debugLog.push(`  Sidebar: Clicked 'Movimientos' (${movLinkClicked})`);
    await delay(5000);
    // Check if page actually navigated
    const urlChanged = !page.url().endsWith("/main");
    if (urlChanged) {
      accountNavOk = true;
    } else {
      debugLog.push("  Sidebar click didn't navigate, URL unchanged");
    }
  }

  // Strategy 2: Use Puppeteer's native click on the sidebar link element
  // (bypasses evaluate-based click which may not trigger Angular)
  if (!accountNavOk) {
    const sidebarLinks = await page.$$("a, .mat-list-item, [routerlink]");
    for (const link of sidebarLinks) {
      const text = await link.evaluate((el) => el.textContent?.trim() || "");
      const box = await link.boundingBox();
      if (text === "Movimientos" && box && box.x < 350) {
        await link.click();
        debugLog.push("  Sidebar: Native-clicked 'Movimientos'");
        await delay(5000);
        const urlChanged = !page.url().endsWith("/main");
        if (urlChanged) accountNavOk = true;
        break;
      }
    }
  }

  // Strategy 3: Dashboard "Movimientos" button (proven to work)
  if (!accountNavOk) {
    debugLog.push("  Sidebar nav failed, trying dashboard 'Movimientos' button...");
    const movBtnClicked = await clickButton(page, "Movimientos", { timeout: 3000 });
    if (movBtnClicked) {
      debugLog.push("  Dashboard: Clicked 'Movimientos' button");
      await delay(5000);
      accountNavOk = true;
    }
  }

  await doSave(page, "04-account-movements");

  // If we navigated to the movements page, try additional account selection
  if (accountNavOk) {
    // Try "Ir a cartolas" link
    const cartolasClicked = await clickText(page, "Ir a cartolas", { timeout: 3000 });
    if (cartolasClicked) {
      debugLog.push("  Clicked 'Ir a cartolas'");
      await delay(4000);
    }

    // Select Cuenta Corriente — only click small link elements, not container divs
    const acctSelected = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a, button, [role='option'], [role='listitem'], li, .mat-list-item"));
      for (const el of links) {
        const text = (el as HTMLElement).innerText?.trim() || "";
        if (text.includes("Cuenta Corriente") && text.length < 100) {
          (el as HTMLElement).click();
          return text.substring(0, 60);
        }
      }
      return null;
    });
    if (acctSelected) {
      debugLog.push(`  Selected: ${acctSelected}`);
      await delay(4000);
    }

    // Click MOVIMIENTOS tab if present
    const movTabClicked = await clickTab(page, "MOVIMIENTOS", { timeout: 3000 });
    if (movTabClicked) {
      debugLog.push("  Clicked MOVIMIENTOS tab");
      await delay(4000);
    }
  }

  await doSave(page, "04b-cuenta-corriente");

  // Capture Cuenta Corriente movements via API
  let checkingCaptureCount = 0;
  const checkingCaptures = await interceptor.waitFor("checking", 12000);
  if (checkingCaptures.length > 0) {
    checkingCaptureCount = checkingCaptures.length;
    const apiMovements = normalizeSantanderCheckingApiMovements(checkingCaptures);
    allMovements.push(...apiMovements);
    debugLog.push(`  Cuenta Corriente API: ${apiMovements.length} movement(s)`);
  } else {
    debugLog.push("  Checking API: no data, trying HTML extraction...");
    const domMovements = await extractMovementsFromDOM(page, MOVEMENT_SOURCE.account, CREDIT_KEYWORDS);
    allMovements.push(...domMovements);
    debugLog.push(`  Cuenta Corriente DOM: ${domMovements.length} movement(s)`);
  }

  // ── 3b. Navigate to Cuenta Vista ──────────────────────────────
  // The dashboard showed "Cuenta Vista $10". Try navigating to it for completeness.
  const hasVistaAccount = await page.evaluate(() => {
    return document.body?.innerText?.includes("Cuenta Vista") ?? false;
  });

  if (hasVistaAccount) {
    debugLog.push("  Navigating to Cuenta Vista...");
    // Try carousel "Next slide" or direct click on "Cuenta Vista"
    let vistaNavOk = false;

    // Try clicking "Next slide" button (carousel navigation)
    const nextSlide = await clickButton(page, "Next slide", { timeout: 2000 });
    if (nextSlide) {
      await delay(2000);
      await clickTab(page, "MOVIMIENTOS", { timeout: 2000 });
      await delay(3000);
      vistaNavOk = true;
    }

    // Or try clicking Cuenta Vista text directly
    if (!vistaNavOk) {
      const vistaClicked = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll("a, button, [role='option'], li, .mat-list-item, span"));
        for (const el of els) {
          const text = (el as HTMLElement).innerText?.trim() || "";
          if (text.includes("Cuenta Vista") && text.length < 100) {
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      });
      if (vistaClicked) {
        await delay(3000);
        await clickTab(page, "MOVIMIENTOS", { timeout: 2000 });
        await delay(3000);
        vistaNavOk = true;
      }
    }

    if (vistaNavOk) {
      const newCaptures = await interceptor.waitFor("checking", 8000);
      if (newCaptures.length > checkingCaptureCount) {
        const vistaCaptures = newCaptures.slice(checkingCaptureCount);
        const vistaMov = normalizeSantanderCheckingApiMovements(vistaCaptures);
        allMovements.push(...vistaMov);
        debugLog.push(`  Cuenta Vista API: ${vistaMov.length} movement(s)`);
      } else {
        debugLog.push("  Cuenta Vista: no new API data");
      }
    }
  }

  debugLog.push(`  Total account movements: ${allMovements.length}`);

  // ── 4. Navigate to credit card section ─────────────────────────
  debugLog.push("5. Navigating to credit cards...");
  progress("Extrayendo movimientos de tarjeta de crédito...");

  // Navigate via sidebar: Tarjetas > Mis Tarjetas de Crédito
  const tarjetasClicked = await clickButton(page, "Tarjetas", { timeout: 5000 });
  if (tarjetasClicked) {
    debugLog.push("  Sidebar: Clicked 'Tarjetas'");
    await delay(2000);
  }

  const misTcClicked =
    (await clickButton(page, "Mis Tarjetas de Crédito", { timeout: 5000 })) ||
    (await clickText(page, "Mis Tarjetas de Crédito", { timeout: 3000 }));
  if (misTcClicked) {
    debugLog.push("  Clicked 'Mis Tarjetas de Crédito'");
    await delay(4000);
  }

  await doSave(page, "05-credit-cards");

  const tcSectionLoaded = misTcClicked ||
    await waitForText(page, "movimientos por facturar", 5000);

  if (tcSectionLoaded) {
    // Track API capture counts to detect new data after tab switches
    let unbilledCaptureCount = 0;
    let billedCaptureCount = 0;

    // ── 4a. Unbilled movements (Pesos) ────────────────────────────
    debugLog.push("  Extracting unbilled movements (Pesos)...");
    const unbilledClicked =
      (await clickTab(page, "MOVIMIENTOS POR FACTURAR", { timeout: 5000 })) ||
      (await clickText(page, "MOVIMIENTOS POR FACTURAR", { exact: true, timeout: 3000 }));
    if (unbilledClicked) {
      await delay(4000);

      const unbilledCaptures = await interceptor.waitFor("cc-unbilled", 10000);
      unbilledCaptureCount = unbilledCaptures.length;
      if (unbilledCaptures.length > 0) {
        const unbilledMovements = normalizeSantanderUnbilledApiMovements(unbilledCaptures);
        allMovements.push(...unbilledMovements);
        debugLog.push(`    API unbilled (Pesos): ${unbilledMovements.length} movement(s)`);
      } else {
        const domMovements = await extractMovementsFromDOM(page, MOVEMENT_SOURCE.credit_card_unbilled, CREDIT_KEYWORDS);
        allMovements.push(...domMovements);
        debugLog.push(`    DOM unbilled (Pesos): ${domMovements.length} movement(s)`);
      }

      // ── 4b. Unbilled movements (Dólares) ──────────────────────────
      const dolaresUnbilledClicked = await clickCurrencyToggle(page, "Dólares");
      if (dolaresUnbilledClicked) {
        debugLog.push("    Switched to Dólares (unbilled)...");
        await delay(4000);

        // Check if a new API call was made for USD unbilled
        const newUnbilledCaptures = await interceptor.waitFor("cc-unbilled", 5000);
        if (newUnbilledCaptures.length > unbilledCaptureCount) {
          const usdCaptures = newUnbilledCaptures.slice(unbilledCaptureCount);
          const usdMovements = normalizeSantanderUnbilledApiMovements(usdCaptures);
          allMovements.push(...usdMovements);
          debugLog.push(`    API unbilled (Dólares): ${usdMovements.length} movement(s)`);
        } else {
          const domMovements = await extractMovementsFromDOM(page, MOVEMENT_SOURCE.credit_card_unbilled, CREDIT_KEYWORDS);
          allMovements.push(...domMovements);
          debugLog.push(`    DOM unbilled (Dólares): ${domMovements.length} movement(s)`);
        }

        // Switch back to Pesos before navigating to billed tab
        await clickCurrencyToggle(page, "Pesos");
        await delay(1000);
      }
    }

    // ── 4c. Billed movements (Pesos) ─────────────────────────────
    debugLog.push("  Extracting billed movements...");
    // The tabs are: MI TARJETA | MOVIMIENTOS POR FACTURAR | MOVIMIENTOS FACTURADOS
    // Try clicking the tab, then fallback to text click
    let billedClicked = await clickTab(page, "MOVIMIENTOS FACTURADOS", { timeout: 5000 });
    if (!billedClicked) {
      billedClicked = await clickText(page, "MOVIMIENTOS FACTURADOS", { exact: true, timeout: 3000 });
    }
    if (!billedClicked) {
      // Try clicking the third tab by index
      billedClicked = await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("[role='tab'], .mat-tab-label, .mat-mdc-tab"));
        for (const tab of tabs) {
          const text = (tab as HTMLElement).innerText?.trim().toUpperCase() || "";
          if (text.includes("FACTURADOS") && !text.includes("POR")) {
            (tab as HTMLElement).click();
            return true;
          }
        }
        return false;
      });
    }
    debugLog.push(`  Billed tab clicked: ${billedClicked}`);
    if (billedClicked) {
      // Default tab is already Pesos — don't click "Pesos" to avoid duplicate API call
      await delay(4000);

      const billedCaptures = await interceptor.waitFor("cc-billed", 10000);
      billedCaptureCount = billedCaptures.length;
      if (billedCaptures.length > 0) {
        const billedMovements = normalizeSantanderBilledApiMovements(billedCaptures);
        allMovements.push(...billedMovements);
        debugLog.push(`    API billed (Pesos): ${billedMovements.length} movement(s)`);
      } else {
        const domMovements = await extractMovementsFromDOM(page, MOVEMENT_SOURCE.credit_card_billed, CREDIT_KEYWORDS);
        allMovements.push(...domMovements);
        debugLog.push(`    DOM billed (Pesos): ${domMovements.length} movement(s)`);
      }

      // Try additional billing periods
      const periods = await listBillingPeriods(page);
      if (periods.length > 1) {
        debugLog.push(`    Found ${periods.length} billing periods: ${periods.join(", ")}`);
        for (let i = 1; i < periods.length && i < 4; i++) {
          const selected = await selectBillingPeriod(page, i);
          if (!selected) continue;
          await delay(4000);

          const periodCaptures = await interceptor.waitFor("cc-billed", 8000);
          if (periodCaptures.length > billedCaptureCount) {
            const newCaptures = periodCaptures.slice(billedCaptureCount);
            billedCaptureCount = periodCaptures.length;
            const periodMovements = normalizeSantanderBilledApiMovements(newCaptures);
            allMovements.push(...periodMovements);
            debugLog.push(`    Period "${periods[i]}": ${periodMovements.length} movement(s)`);
          }
        }
      }

      // ── 4d. Billed movements (Dólares) ───────────────────────────
      const dolaresBilledClicked = await clickCurrencyToggle(page, "Dólares");
      if (dolaresBilledClicked) {
        debugLog.push("    Switched to Dólares (billed)...");
        await delay(4000);

        const newBilledCaptures = await interceptor.waitFor("cc-billed", 5000);
        if (newBilledCaptures.length > billedCaptureCount) {
          const usdCaptures = newBilledCaptures.slice(billedCaptureCount);
          const usdMovements = normalizeSantanderBilledApiMovements(usdCaptures);
          allMovements.push(...usdMovements);
          debugLog.push(`    API billed (Dólares): ${usdMovements.length} movement(s)`);
        } else {
          const domMovements = await extractMovementsFromDOM(page, MOVEMENT_SOURCE.credit_card_billed, CREDIT_KEYWORDS);
          allMovements.push(...domMovements);
          debugLog.push(`    DOM billed (Dólares): ${domMovements.length} movement(s)`);
        }
      }
    }
  } else {
    debugLog.push("  Could not open credit card section");
  }

  // ── 5. Normalize dates & deduplicate ────────────────────────────
  // API normalizers return mixed formats: YYYY-MM-DD (billed), DD-MM-YYYY (checking/unbilled)
  // DOM extractor returns DD-MM-YYYY. Normalize everything to DD-MM-YYYY.
  for (const m of allMovements) {
    m.date = toDateDMY(m.date);
  }
  allMovements = deduplicateMovements(allMovements);

  // Extract balance from movements or page
  let balance: number | undefined;
  const withBalance = allMovements.find((m) => m.balance > 0);
  if (withBalance) {
    balance = withBalance.balance;
  } else {
    balance = await page.evaluate(() => {
      const body = document.body?.innerText || "";
      const match = body.match(/(?:saldo|disponible)[^$]*\$\s*([\d.,]+)/i);
      if (match) {
        return parseInt(match[1].replace(/\./g, "").replace(",", ""), 10) || 0;
      }
      return 0;
    });
    if (balance === 0) balance = undefined;
  }

  debugLog.push(`6. Total movements: ${allMovements.length}`);
  if (balance !== undefined) {
    debugLog.push(`7. Balance: $${balance.toLocaleString("es-CL")}`);
  }

  progress(`Listo — ${allMovements.length} movimientos totales`);

  // ── 6. Logout ──────────────────────────────────────────────────
  await clickButton(page, "Cerrar sesión", { timeout: 3000 });
  debugLog.push("8. Logout");

  await doSave(page, "06-final");
  const ss = doScreenshots
    ? ((await page.screenshot({ encoding: "base64", fullPage: true })) as string)
    : undefined;

  return {
    success: true,
    bank,
    accounts: [{ balance, movements: allMovements }],
    screenshot: ss,
    debug: debugLog.join("\n"),
  };
}

// ─── Export ──────────────────────────────────────────────────────────

const santander: BankScraper = {
  id: "santander",
  name: "Banco Santander",
  url: BANK_URL,
  scrape: (options) => runScraper("santander", options, {}, scrapeSantanderV2),
};

export default santander;
