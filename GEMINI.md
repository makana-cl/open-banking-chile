# banco-falabella-scraper

## Context for Gemini
This is a Node.js/TypeScript project that scrapes Banco Falabella (a Chilean bank) to extract bank movements and balance. It uses Puppeteer to automate a headless Chrome browser.

## Quick start instructions for users
1. Install Node.js 18+ and Google Chrome
2. Clone the repo and run `npm install && npm run build`
3. Set environment variables: `FALABELLA_RUT` and `FALABELLA_PASS`
4. Run: `source .env && node dist/cli.js --pretty`

## Key files
- `src/scraper.ts` — Main scraper (login flow, navigation, data extraction)
- `src/types.ts` — TypeScript interfaces
- `src/cli.ts` — CLI tool
- `src/index.ts` — Library entry point

## How the scraper works
1. Opens Chrome headless → navigates to bancofalabella.cl
2. Clicks "Mi cuenta" → fills RUT and password → submits login
3. Closes post-login popups
4. Navigates to "Cartola" (account statement) section
5. Extracts movements from HTML tables (Fecha, Descripción, Cargo, Abono, Saldo)
6. Returns structured JSON

## Common user needs
- **Setup help**: They need Chrome installed + env vars configured
- **Debugging**: Use `--screenshots` flag or `--headful` for visual debugging
- **Integration**: The `scrapeFalabella()` function returns a promise with movements array
- **Automation**: Can be set up as a cron job or systemd timer
- **2FA issues**: The scraper cannot handle 2FA/dynamic keys — this is a bank-side limitation

## Important security notes
- Credentials never leave the user's machine
- Always use environment variables, never hardcode credentials
- The base64 screenshot in results may contain sensitive info
