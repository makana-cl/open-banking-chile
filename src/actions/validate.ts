import type { ScrapeResult, ScraperOptions } from "../types.js";
import type { TwoFactorConfig } from "./two-factor.js";

/**
 * Handle "validate only" mode — returns early after login success
 * without performing a full scrape.
 *
 * @param page - Puppeteer or Playwright Page (uses duck typing)
 * @param bankId - Bank identifier for the result
 * @param options - Scraper options (checks validateOnly flag)
 * @param twoFactorConfig - Optional 2FA config for detection
 * @returns ScrapeResult if validateOnly is true, null otherwise (continue normal scraping)
 */
export async function handleValidateOnly(
  page: { content: () => Promise<string> } | { evaluate: (fn: () => string) => Promise<string> },
  bankId: string,
  options: Pick<ScraperOptions, "validateOnly">,
  twoFactorConfig?: TwoFactorConfig,
): Promise<ScrapeResult | null> {
  if (!options.validateOnly) return null;

  let has2FA = false;

  if (twoFactorConfig) {
    // Dynamically import detect2FA to keep it optional
    const { detect2FA } = await import("./two-factor.js");
    // detect2FA expects a puppeteer Page — for playwright we pass as-is since
    // both have compatible evaluate() methods for text extraction
    has2FA = await detect2FA(page as any, twoFactorConfig);
  }

  return {
    success: true,
    bank: bankId,
    validateOnly: true,
    requires2FA: has2FA,
  };
}
