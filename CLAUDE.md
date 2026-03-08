# banco-falabella-scraper

## What is this?
A Node.js/TypeScript scraper for Banco Falabella (Chile). It logs into the bank's web portal using Puppeteer and extracts bank movements (transactions) and balance as clean JSON.

## Project structure
```
src/
  index.ts      — Main export (scrapeFalabella function + types)
  scraper.ts    — Core scraper logic (login, navigation, extraction)
  types.ts      — TypeScript types (BankMovement, ScrapeResult, ScraperOptions)
  cli.ts        — CLI entry point (reads env vars, outputs JSON)
```

## How to help the user

### Setup
1. They need Node.js >= 18 and Google Chrome or Chromium installed
2. `npm install` to install dependencies
3. `npm run build` to compile TypeScript
4. Copy `.env.example` to `.env` and fill in their RUT and password

### Running
```bash
source .env && node dist/cli.js --pretty
```

### Common issues
- **Chrome not found**: They need to install it or set `CHROME_PATH`
  - Ubuntu: `sudo apt install google-chrome-stable`
  - macOS: `brew install --cask google-chrome`
- **2FA prompt**: The scraper can't handle dynamic keys. The bank sometimes asks for 2FA.
- **0 movements**: The bank may have changed their HTML structure. Use `--screenshots` to debug.
- **Login fails**: Check RUT format and password. Use `--headful` to see the browser.

### Using as a library
```typescript
import { scrapeFalabella } from "banco-falabella-scraper";

const result = await scrapeFalabella({
  rut: "12345678-9",
  password: "clave",
});
// result.movements = [{ date, description, amount, balance }]
```

## Architecture notes
- Uses `puppeteer-core` (requires system Chrome, doesn't bundle Chromium)
- 3 extraction strategies: table with headers > SPA components > generic pattern matching
- The bank is a SPA (Angular) so navigation relies on clicking elements, not URL changes
- All credentials stay local — nothing is sent to any external server
- The scraper auto-detects Chrome/Chromium paths on Linux, macOS, and WSL
