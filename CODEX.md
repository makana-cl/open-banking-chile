# banco-falabella-scraper

## For Codex / ChatGPT / OpenAI assistants

### What this project does
Scrapes Banco Falabella (Chilean bank) web portal to extract account movements and balance as JSON. Uses Puppeteer (headless Chrome automation).

### Prerequisites
- Node.js >= 18
- Google Chrome or Chromium installed on the system
- Bank credentials (RUT + password)

### Setup
```bash
git clone https://github.com/kaihv/banco-falabella-scraper.git
cd banco-falabella-scraper
npm install
npm run build
cp .env.example .env
# Edit .env with real credentials
```

### Usage (CLI)
```bash
source .env
node dist/cli.js --pretty          # Full output
node dist/cli.js --movements       # Just movements array
node dist/cli.js --screenshots     # Save debug screenshots
node dist/cli.js --headful         # Show browser window
```

### Usage (Library)
```typescript
import { scrapeFalabella } from "banco-falabella-scraper";

const result = await scrapeFalabella({
  rut: "12345678-9",
  password: "your_password",
  // Optional:
  // chromePath: "/usr/bin/chromium",
  // saveScreenshots: true,
  // headful: true,
});

if (result.success) {
  // result.movements: BankMovement[] — array of transactions
  // result.balance: number — current account balance
  // result.debug: string — step-by-step log
}
```

### Output format
```json
{
  "success": true,
  "movements": [
    {
      "date": "08-03-2026",
      "description": "COMPRA EN COMERCIO",
      "amount": -45000,
      "balance": 1200000
    }
  ],
  "balance": 1200000
}
```

### Troubleshooting
| Problem | Solution |
|---------|----------|
| Chrome not found | Install Chrome or set `CHROME_PATH` env var |
| 2FA/Dynamic key | Can't automate — bank security feature |
| 0 movements | Bank HTML may have changed, use --screenshots |
| Login fails | Verify RUT and password, try --headful |

### File structure
```
src/scraper.ts  — Core scraper logic
src/types.ts    — TypeScript types
src/cli.ts      — CLI entry point
src/index.ts    — Library exports
```

### Security
- All processing is local, no data sent to external servers
- Use environment variables for credentials
- Screenshot output may contain sensitive data
