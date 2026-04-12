# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is this?

Open source scrapers for Chilean banks. Clean architecture with three layers: infrastructure (browser lifecycle), actions (reusable scraping operations), and banks (bank-specific orchestration). 10 banks supported.

## Project structure

```
src/
  index.ts                 — Registry of all banks, getBank(), listBanks()
  types.ts                 — BankScraper interface, BankMovement, ScrapeResult, ScraperOptions
  utils.ts                 — Shared utilities (formatRut, findChrome, parseChileanAmount, normalizeDate, etc.)
  cli.ts                   — CLI entry point (--bank, --list, --pretty, --movements)
  intercept.ts             — Network interceptor: capture API responses by URL prefix during scraping
  infrastructure/
    browser.ts             — Centralized browser launch, session management, anti-detection
    scraper-runner.ts      — Execution pipeline: validate → launch → scrape → logout → cleanup
    downloader.ts          — File download helpers (temp dirs, CDP download config, wait-for-file)
  actions/
    login.ts               — Generic login (RUT formats, password, submit, error detection)
    navigation.ts          — DOM navigation (click by text, sidebars, banner dismissal)
    extraction.ts          — Movement extraction from HTML tables with fallbacks
    pagination.ts          — Multi-page iteration (Siguiente, Ver más)
    credit-card.ts         — Credit card movement extraction (tabs, billing periods)
    balance.ts             — Balance extraction (regex + CSS selector fallbacks)
    two-factor.ts          — 2FA detection and wait (configurable keywords/timeout)
  banks/
    bancosecurity.ts, bchile.ts, bci.ts, bestado.ts, bice.ts,
    edwards.ts, falabella.ts, itau.ts, santander.ts, scotiabank.ts
test/
  *.mjs                   — Integration tests per bank (bchile, bci, bestado, falabella, itau)
```

## Build, test, lint

```bash
npm run build              # tsup → dist/ (ESM + CJS + .d.ts)
npm run dev                # tsup --watch
npm test                   # vitest run (unit tests)
npm run test:watch         # vitest in watch mode
npx vitest run src/utils.test.ts   # Single test file
npx tsc --noEmit           # Type check without emitting
```

Build uses **tsup** (see `tsup.config.ts`). Two entry points: `src/index.ts` (library) and `src/cli.ts` (CLI binary).

## Dependencies

- **puppeteer-core** — primary browser automation (Chromium)
- **playwright-core** — used by some bank scrapers as alternative driver
- **xlsx** — parsing Excel/XLS downloads (e.g. BancoEstado cartola)
- **dotenv** — loads `.env` for credentials

## How to help the user

### Setup
1. Node.js >= 18 + Google Chrome or Chromium
2. `npm install && npm run build`
3. Copy `.env.example` → `.env`, fill in credentials

### Running
```bash
source .env && node dist/cli.js --bank falabella --pretty
```

### Adding a new bank
1. Create `src/banks/<bank-id>.ts` implementing `BankScraper`
2. Use `runScraper()` from infrastructure and compose actions from `src/actions/`
3. Register in `src/index.ts`
4. Add env vars to `.env.example`
5. See CONTRIBUTING.md for full guide

### Common issues
- Chrome not found → install or set `CHROME_PATH`
- 2FA → can't automate, bank security feature
- 0 movements → use `--screenshots` to debug
