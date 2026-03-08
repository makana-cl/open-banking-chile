import puppeteer, { type Page } from "puppeteer-core";
import * as fs from "fs";
import * as path from "path";
import type { BankMovement, ScrapeResult, ScraperOptions } from "./types";

const BANK_URL = "https://www.bancofalabella.cl";

// ─── Utilidades ────────────────────────────────────────────────

function formatRut(rut: string): string {
  const clean = rut.replace(/[.\-]/g, "");
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  const formatted = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${formatted}-${dv}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findChrome(customPath?: string): string | null {
  if (customPath && fs.existsSync(customPath)) return customPath;

  const candidates = [
    // Linux
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    // Windows (WSL)
    "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
    "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ─── Login helpers ─────────────────────────────────────────────

async function fillRut(page: Page, rut: string): Promise<boolean> {
  const formattedRut = formatRut(rut);

  const selectors = [
    'input[name*="rut"]',
    'input[id*="rut"]',
    'input[placeholder*="RUT"]',
    'input[placeholder*="Rut"]',
    'input[type="text"][name*="user"]',
    'input[type="text"][name*="username"]',
    'input[id*="user"]',
    'input[aria-label*="RUT"]',
    'input[aria-label*="rut"]',
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.type(formattedRut, { delay: 50 });
        return true;
      }
    } catch {
      /* try next */
    }
  }

  // Fallback: first visible text input
  try {
    const filled = await page.evaluate((rutVal: string) => {
      const inputs = Array.from(
        document.querySelectorAll('input[type="text"], input:not([type])')
      );
      for (const input of inputs) {
        const el = input as HTMLInputElement;
        if (el.offsetParent !== null && !el.disabled) {
          el.focus();
          el.value = rutVal;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
      return false;
    }, formattedRut);
    if (filled) return true;
  } catch {
    /* continue */
  }

  return false;
}

async function fillPassword(page: Page, password: string): Promise<boolean> {
  const selectors = [
    'input[type="password"]',
    'input[name*="pass"]',
    'input[name*="clave"]',
    'input[id*="pass"]',
    'input[id*="clave"]',
    'input[placeholder*="Clave"]',
    'input[placeholder*="clave"]',
    'input[placeholder*="Contraseña"]',
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await el.type(password, { delay: 50 });
        return true;
      }
    } catch {
      /* try next */
    }
  }

  return false;
}

async function clickSubmitButton(page: Page): Promise<boolean> {
  const selectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button[class*="login"]',
    'button[class*="submit"]',
    'button[id*="login"]',
    'button[id*="submit"]',
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        return true;
      }
    } catch {
      /* try next */
    }
  }

  // Text-based fallback
  const texts = ["Ingresar", "Iniciar sesión", "Entrar", "Login", "Continuar"];
  for (const text of texts) {
    try {
      const clicked = await page.evaluate((t: string) => {
        const buttons = Array.from(
          document.querySelectorAll("button, input[type='submit'], a")
        );
        for (const btn of buttons) {
          if (
            (btn as HTMLElement).innerText?.trim().toLowerCase() ===
            t.toLowerCase()
          ) {
            (btn as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, text);
      if (clicked) return true;
    } catch {
      /* try next */
    }
  }

  await page.keyboard.press("Enter");
  return true;
}

// ─── Navigation helpers ────────────────────────────────────────

async function closePopups(page: Page): Promise<void> {
  // Press Escape multiple times
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Escape");
    await delay(300);
  }
  // Click any close/X buttons on modals
  await page.evaluate(() => {
    const closeButtons = Array.from(
      document.querySelectorAll(
        '[class*="close"], [aria-label*="close"], [aria-label*="cerrar"], button'
      )
    );
    for (const btn of closeButtons) {
      const text = (btn as HTMLElement).innerText?.trim();
      if (
        text === "X" ||
        text === "×" ||
        text === "✕" ||
        text === "Cerrar"
      ) {
        (btn as HTMLElement).click();
      }
    }
  });
  await delay(1000);
}

async function tryExpandDateRange(
  page: Page,
  debugLog: string[]
): Promise<void> {
  try {
    const selectInfo = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll("select"));
      return selects.map((sel, i) => {
        const options = Array.from(sel.querySelectorAll("option"));
        return {
          index: i,
          name: sel.name || sel.id || `select-${i}`,
          selectedValue: sel.value,
          options: options.map((o) => ({
            text: o.text.trim(),
            value: o.value,
            selected: o.selected,
          })),
        };
      });
    });

    if (selectInfo.length > 0) {
      debugLog.push(`  Found ${selectInfo.length} select dropdowns`);
      for (const sel of selectInfo) {
        for (const opt of sel.options) {
          const text = opt.text.toLowerCase();
          if (
            text.includes("todos") ||
            text.includes("último mes") ||
            text.includes("30 día") ||
            text.includes("mes anterior")
          ) {
            await page.evaluate(
              (selIdx: number, optValue: string) => {
                const selects = document.querySelectorAll("select");
                const select = selects[selIdx] as HTMLSelectElement;
                if (select) {
                  select.value = optValue;
                  select.dispatchEvent(new Event("change", { bubbles: true }));
                }
              },
              sel.index,
              opt.value
            );
            debugLog.push(`  Changed [${sel.name}] to "${opt.text}"`);
            await delay(3000);
            break;
          }
        }
      }
    }

    // Click "Buscar"/"Consultar" if present
    const clickedSearch = await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll("button, input[type='submit']")
      );
      for (const btn of buttons) {
        const text = (btn as HTMLElement).innerText?.trim().toLowerCase();
        if (
          text === "buscar" ||
          text === "consultar" ||
          text === "filtrar"
        ) {
          (btn as HTMLElement).click();
          return text;
        }
      }
      return null;
    });

    if (clickedSearch) {
      debugLog.push(`  Clicked "${clickedSearch}" button`);
      await delay(3000);
    }
  } catch {
    /* ignore filter errors */
  }
}

// ─── Movement extraction ───────────────────────────────────────

async function extractMovements(page: Page): Promise<BankMovement[]> {
  return await page.evaluate(() => {
    const movements: BankMovement[] = [];

    // Strategy 1: Table with proper headers (Fecha, Cargo, Abono, Saldo)
    const tables = document.querySelectorAll("table");
    for (const table of tables) {
      let cargoIdx = -1;
      let abonoIdx = -1;
      let saldoIdx = -1;
      let hasHeaders = false;

      const allRows = Array.from(table.querySelectorAll("tr"));
      for (const row of allRows) {
        const ths = row.querySelectorAll("th");
        if (ths.length >= 3) {
          const headerTexts = Array.from(ths).map((h) =>
            (h as HTMLElement).innerText?.trim().toLowerCase()
          );
          if (headerTexts.some((h) => h.includes("fecha"))) {
            cargoIdx = headerTexts.findIndex((h) => h.includes("cargo"));
            abonoIdx = headerTexts.findIndex((h) => h.includes("abono"));
            saldoIdx = headerTexts.findIndex((h) => h.includes("saldo"));
            hasHeaders = true;
            break;
          }
        }
      }

      if (!hasHeaders) continue;

      for (const row of allRows) {
        const cells = row.querySelectorAll("td");
        if (cells.length < 3) continue;

        const texts = Array.from(cells).map((c) =>
          (c as HTMLElement).innerText?.trim()
        );
        // Strict date check: dd-mm-yyyy, dd/mm/yyyy, dd.mm.yyyy
        if (!texts[0]?.match(/^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}$/)) continue;

        let amount = 0;
        let balance = 0;

        if (cargoIdx >= 0 && texts[cargoIdx]) {
          const val =
            parseInt(texts[cargoIdx].replace(/[^0-9]/g, ""), 10) || 0;
          if (val > 0) amount = -val; // Cargo = negative
        }
        if (abonoIdx >= 0 && texts[abonoIdx]) {
          const val =
            parseInt(texts[abonoIdx].replace(/[^0-9]/g, ""), 10) || 0;
          if (val > 0) amount = val; // Abono = positive
        }
        if (saldoIdx >= 0 && texts[saldoIdx]) {
          balance =
            parseInt(texts[saldoIdx].replace(/[^0-9]/g, ""), 10) || 0;
          if (texts[saldoIdx].includes("-")) balance = -balance;
        }

        if (amount !== 0) {
          movements.push({
            date: texts[0],
            description: texts[1] || "",
            amount,
            balance,
          });
        }
      }
    }

    // Strategy 2: SPA movement components (class-based)
    if (movements.length === 0) {
      const movementEls = document.querySelectorAll(
        '[class*="movement"], [class*="transaction"], [class*="movimiento"], [class*="Movement"], [class*="Transaction"]'
      );
      for (const el of movementEls) {
        const text = (el as HTMLElement).innerText || "";
        const dateMatch = text.match(/(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})/);
        const amountMatch = text.match(/\$[\d.,]+/g);
        if (dateMatch && amountMatch) {
          const lines = text
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          const descLine = lines.find(
            (l) =>
              !l.match(/^\$/) &&
              !l.match(/^\d{1,2}[/\-.]/) &&
              l.length > 2
          );
          const isNegative =
            text.includes("Cargo") ||
            text.includes("cargo") ||
            text.includes("-$");
          const amt =
            parseInt(amountMatch[0].replace(/[^0-9]/g, ""), 10) || 0;

          movements.push({
            date: dateMatch[1],
            description: descLine || "",
            amount: isNegative ? -amt : amt,
            balance:
              amountMatch.length > 1
                ? parseInt(
                    amountMatch[amountMatch.length - 1].replace(/[^0-9]/g, ""),
                    10
                  )
                : 0,
          });
        }
      }
    }

    // Strategy 3: Generic pattern matching (divs with dates and amounts)
    if (movements.length === 0) {
      const allElements = document.querySelectorAll(
        "div, li, article, section"
      );
      for (const el of allElements) {
        if (el.children.length >= 3) {
          const text = (el as HTMLElement).innerText || "";
          const lines = text.split("\n");
          if (lines.length >= 3 && lines.length <= 8) {
            const dateMatch = text.match(
              /(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})/
            );
            const amountMatch = text.match(/\$[\d.,]+/);
            if (dateMatch && amountMatch) {
              const trimmedLines = lines.map((l) => l.trim()).filter(Boolean);
              const descLine = trimmedLines.find(
                (l) =>
                  !l.match(/^\$/) &&
                  !l.match(/^\d{1,2}[/\-.]/) &&
                  l.length > 3
              );
              const amt =
                parseInt(amountMatch[0].replace(/[^0-9]/g, ""), 10) || 0;

              movements.push({
                date: dateMatch[1],
                description: descLine || "",
                amount: amt,
                balance: 0,
              });
            }
          }
        }
      }
    }

    // Deduplicate
    const seen = new Set<string>();
    return movements.filter((m) => {
      const key = `${m.date}|${m.description}|${m.amount}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
}

// ─── Main scraper ──────────────────────────────────────────────

/**
 * Scrapes Banco Falabella's web portal to extract bank movements and balance.
 *
 * @param options - RUT, password, and optional configuration
 * @returns Movements array, current balance, and debug information
 *
 * @example
 * ```ts
 * const result = await scrapeFalabella({
 *   rut: "12345678-9",
 *   password: "mi_clave",
 * });
 *
 * if (result.success) {
 *   console.log(`Saldo: $${result.balance}`);
 *   console.log(`${result.movements.length} movimientos`);
 *   for (const m of result.movements) {
 *     console.log(`${m.date} | ${m.description} | $${m.amount}`);
 *   }
 * }
 * ```
 */
export async function scrapeFalabella(
  options: ScraperOptions
): Promise<ScrapeResult> {
  const { rut, password, chromePath, saveScreenshots, headful } = options;

  if (!rut || !password) {
    return {
      success: false,
      movements: [],
      error: "Debes proveer RUT y clave.",
    };
  }

  const executablePath = findChrome(chromePath);
  if (!executablePath) {
    return {
      success: false,
      movements: [],
      error:
        "No se encontró Chrome/Chromium. Instala Google Chrome o pasa chromePath en las opciones.\n" +
        "  Ubuntu/Debian: sudo apt install google-chrome-stable\n" +
        "  macOS: brew install --cask google-chrome\n" +
        "  O descarga desde: https://www.google.com/chrome/",
    };
  }

  let browser;
  const debugLog: string[] = [];

  const saveScreenshot = async (page: Page, name: string) => {
    if (!saveScreenshots) return;
    const dir = path.resolve("screenshots");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
    debugLog.push(`  Screenshot saved: screenshots/${name}.png`);
  };

  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: !headful,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--window-size=1280,900",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );

    // ── Step 1: Navigate to bank ───────────────────────────────
    debugLog.push("1. Navigating to bank homepage...");
    await page.goto(BANK_URL, { waitUntil: "networkidle2", timeout: 30000 });
    await delay(2000);

    // Dismiss cookie banner
    try {
      await page.evaluate(() => {
        const btns = Array.from(
          document.querySelectorAll("button, a, span")
        );
        for (const btn of btns) {
          if (
            (btn as HTMLElement).innerText?.trim().toLowerCase() === "entendido"
          ) {
            (btn as HTMLElement).click();
            return;
          }
        }
      });
      await delay(1000);
    } catch {
      /* no cookie banner */
    }

    await saveScreenshot(page, "01-homepage");

    // ── Step 2: Click "Mi cuenta" ──────────────────────────────
    debugLog.push("2. Clicking 'Mi cuenta'...");
    const miCuentaClicked = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a, button"));
      for (const link of links) {
        const text = (link as HTMLElement).innerText?.trim();
        if (text === "Mi cuenta") {
          (link as HTMLElement).click();
          return true;
        }
      }
      return false;
    });

    if (!miCuentaClicked) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return {
        success: false,
        movements: [],
        error: "No se encontró el botón 'Mi cuenta'",
        screenshot: screenshot as string,
        debug: debugLog.join("\n"),
      };
    }

    await delay(4000);
    await saveScreenshot(page, "02-login-form");

    // ── Step 3: Fill RUT ───────────────────────────────────────
    debugLog.push("3. Filling RUT...");
    const rutFilled = await fillRut(page, rut);
    if (!rutFilled) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return {
        success: false,
        movements: [],
        error: `No se encontró campo de RUT en ${page.url()}`,
        screenshot: screenshot as string,
        debug: debugLog.join("\n"),
      };
    }
    await delay(1500);

    // ── Step 4: Fill password ──────────────────────────────────
    debugLog.push("4. Filling password...");
    let passwordFilled = await fillPassword(page, password);
    if (!passwordFilled) {
      // Sometimes the password field appears after pressing Enter on RUT
      await page.keyboard.press("Enter");
      await delay(3000);
      passwordFilled = await fillPassword(page, password);
    }

    if (!passwordFilled) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return {
        success: false,
        movements: [],
        error: `No se encontró campo de clave en ${page.url()}`,
        screenshot: screenshot as string,
        debug: debugLog.join("\n"),
      };
    }
    await delay(1000);

    // ── Step 5: Submit login ───────────────────────────────────
    debugLog.push("5. Submitting login...");
    await clickSubmitButton(page);
    await delay(8000);
    await saveScreenshot(page, "03-after-login");

    // Check for 2FA
    const pageContent = (await page.content()).toLowerCase();
    if (
      pageContent.includes("clave dinámica") ||
      pageContent.includes("clave dinamica") ||
      pageContent.includes("segundo factor") ||
      pageContent.includes("código de verificación")
    ) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return {
        success: false,
        movements: [],
        error:
          "El banco pide clave dinámica (2FA). No se puede automatizar este paso.",
        screenshot: screenshot as string,
        debug: debugLog.join("\n"),
      };
    }

    // Check for login errors
    const errorCheck = await page.evaluate(() => {
      const errorEls = document.querySelectorAll(
        '[class*="error"], [class*="alert"], [role="alert"], [class*="Error"]'
      );
      for (const el of errorEls) {
        const text = (el as HTMLElement).innerText?.trim();
        if (text && text.length > 5 && text.length < 200) return text;
      }
      return null;
    });

    if (errorCheck) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return {
        success: false,
        movements: [],
        error: `Error del banco: ${errorCheck}`,
        screenshot: screenshot as string,
        debug: debugLog.join("\n"),
      };
    }

    debugLog.push(`6. Login OK! URL: ${page.url()}`);

    // ── Step 6: Close popups ───────────────────────────────────
    await closePopups(page);

    // ── Step 7: Navigate to Cartola ────────────────────────────
    debugLog.push("7. Looking for Cartola/Movimientos...");

    const navTargets = [
      { text: "cartola", exact: false },
      { text: "últimos movimientos", exact: false },
      { text: "movimientos", exact: true },
      { text: "estado de cuenta", exact: false },
    ];

    let navigated = false;

    for (const target of navTargets) {
      if (navigated) break;
      const result = await page.evaluate(
        (t: { text: string; exact: boolean }) => {
          const elements = Array.from(
            document.querySelectorAll(
              "a, button, [role='tab'], [role='menuitem'], li, span"
            )
          );
          for (const el of elements) {
            const text =
              (el as HTMLElement).innerText?.trim().toLowerCase() || "";
            const href = (el as HTMLAnchorElement).href || "";
            if (href.includes("cc-nuevos") || href.includes("comenzar"))
              continue;
            if (text.includes("historial de transferencia")) continue;

            const match = t.exact ? text === t.text : text.includes(t.text);
            if (match && text.length < 50) {
              (el as HTMLElement).click();
              return `Clicked: "${text}"`;
            }
          }
          return null;
        },
        target
      );

      if (result) {
        debugLog.push(`  ${result}`);
        navigated = true;
        await delay(4000);
      }
    }

    // If no Cartola link found, try clicking on account first
    if (!navigated) {
      debugLog.push(
        "8. No Cartola link found. Looking for account to click..."
      );

      const clickedAccount = await page.evaluate(() => {
        const allElements = Array.from(
          document.querySelectorAll("a, div, button, tr, li")
        );
        for (const el of allElements) {
          const text = (el as HTMLElement).innerText?.trim() || "";
          const href = (el as HTMLAnchorElement).href || "";
          if (href.includes("cc-nuevos") || href.includes("comenzar")) continue;

          // Look for Cuenta Corriente links
          if (
            (text.toLowerCase().includes("cuenta corriente") ||
              text.toLowerCase().includes("cuenta vista")) &&
            text.length < 100
          ) {
            if (el.tagName === "A") {
              (el as HTMLElement).click();
              return `Clicked: "${text.substring(0, 60)}"`;
            }
            const childLink = el.querySelector(
              "a:not([href*='cc-nuevos'])"
            ) as HTMLElement;
            if (childLink) {
              childLink.click();
              return `Clicked child: "${childLink.innerText?.trim().substring(0, 60)}"`;
            }
            (el as HTMLElement).click();
            return `Clicked element: "${text.substring(0, 60)}"`;
          }
        }
        return null;
      });

      if (clickedAccount) {
        debugLog.push(`  ${clickedAccount}`);
        await delay(4000);

        // Retry Cartola navigation inside account detail
        if (
          page.url().includes("web2.bancofalabella") ||
          page.url().includes("web-clientes")
        ) {
          for (const target of navTargets) {
            const result = await page.evaluate(
              (t: { text: string; exact: boolean }) => {
                const elements = Array.from(
                  document.querySelectorAll(
                    "a, button, [role='tab'], [role='menuitem'], li, span"
                  )
                );
                for (const el of elements) {
                  const text =
                    (el as HTMLElement).innerText?.trim().toLowerCase() || "";
                  const href = (el as HTMLAnchorElement).href || "";
                  if (
                    href.includes("cc-nuevos") ||
                    href.includes("comenzar")
                  )
                    continue;
                  if (text.includes("historial de transferencia")) continue;

                  const match = t.exact
                    ? text === t.text
                    : text.includes(t.text);
                  if (match && text.length < 50) {
                    (el as HTMLElement).click();
                    return `Clicked: "${text}"`;
                  }
                }
                return null;
              },
              target
            );

            if (result) {
              debugLog.push(`  ${result}`);
              navigated = true;
              await delay(4000);
              break;
            }
          }
        }
      }
    }

    await saveScreenshot(page, "04-movements-page");

    // ── Step 8: Try expanding date range ───────────────────────
    await tryExpandDateRange(page, debugLog);

    // ── Step 9: Extract movements ──────────────────────────────
    const movements = await extractMovements(page);
    debugLog.push(`9. Extracted ${movements.length} movements`);
    movements.slice(0, 3).forEach((m, i) => {
      debugLog.push(
        `  [${i}] ${m.date} | ${m.description} | $${m.amount.toLocaleString("es-CL")} | saldo: $${m.balance.toLocaleString("es-CL")}`
      );
    });

    // ── Step 10: Get balance ───────────────────────────────────
    let balance: number | undefined;
    if (movements.length > 0 && movements[0].balance > 0) {
      balance = movements[0].balance;
    } else {
      balance = await page.evaluate(() => {
        const bodyText = document.body?.innerText || "";
        const match = bodyText.match(
          /Saldo disponible[\s\S]{0,50}\$\s*([\d.]+)/i
        );
        if (match) {
          return parseInt(match[1].replace(/[^0-9]/g, ""), 10);
        }
        return undefined;
      });
    }

    await saveScreenshot(page, "05-final");

    const screenshot = await page.screenshot({
      encoding: "base64",
      fullPage: true,
    });

    return {
      success: true,
      movements,
      balance: balance || undefined,
      screenshot: screenshot as string,
      debug: debugLog.join("\n"),
    };
  } catch (error) {
    return {
      success: false,
      movements: [],
      error: `Error del scraper: ${error instanceof Error ? error.message : String(error)}`,
      debug: debugLog.join("\n"),
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
