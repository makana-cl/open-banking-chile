# banco-falabella-scraper

Scraper no oficial para **Banco Falabella Chile**. Obtén tus movimientos bancarios y saldo como JSON limpio.

> **Disclaimer**: Este proyecto no está afiliado con Banco Falabella. Úsalo bajo tu propia responsabilidad y solo con tus propias credenciales. El scraping de sitios bancarios puede violar los términos de servicio del banco.

## Features

- Login automático al portal web de Banco Falabella
- Extracción de movimientos con fecha, descripción, monto y saldo
- Detección automática de cargos (negativos) y abonos (positivos)
- Balance actual de la cuenta
- CLI para uso directo desde terminal
- API programática para integrar en tus proyectos
- Screenshots de debugging opcionales
- Detección automática de Chrome/Chromium en Linux, macOS y WSL

## Requisitos

- **Node.js** >= 18
- **Google Chrome** o **Chromium** instalado en el sistema

### Instalar Chrome

```bash
# Ubuntu/Debian
sudo apt update && sudo apt install -y google-chrome-stable

# macOS
brew install --cask google-chrome

# O descarga desde https://www.google.com/chrome/
```

## Instalación

```bash
# Desde npm
npm install banco-falabella-scraper

# O clonar el repo
git clone https://github.com/kaihv/banco-falabella-scraper.git
cd banco-falabella-scraper
npm install
npm run build
```

## Uso

### CLI

```bash
# Configurar credenciales
export FALABELLA_RUT=12345678-9
export FALABELLA_PASS=tu_clave

# Ejecutar
npx banco-falabella-scraper --pretty

# Solo movimientos
npx banco-falabella-scraper --movements | jq .

# Con screenshots (debugging)
npx banco-falabella-scraper --screenshots --pretty
```

**Opciones CLI:**

| Flag | Descripción |
|------|-------------|
| `--pretty` | JSON formateado con indentación |
| `--movements` | Solo imprimir array de movimientos |
| `--screenshots` | Guardar screenshots en `./screenshots/` |
| `--headful` | Abrir Chrome visible (debugging) |
| `--help` | Mostrar ayuda |

### Como librería

```typescript
import { scrapeFalabella } from "banco-falabella-scraper";

const result = await scrapeFalabella({
  rut: "12345678-9",
  password: "mi_clave",
});

if (result.success) {
  console.log(`Saldo: $${result.balance?.toLocaleString("es-CL")}`);
  console.log(`${result.movements.length} movimientos\n`);

  for (const m of result.movements) {
    const sign = m.amount > 0 ? "+" : "";
    console.log(
      `${m.date} | ${m.description.padEnd(40)} | ${sign}$${m.amount.toLocaleString("es-CL")}`
    );
  }
} else {
  console.error("Error:", result.error);
}
```

### Output

```json
{
  "success": true,
  "movements": [
    {
      "date": "08-03-2026",
      "description": "COMPRA SUPERMERCADO LIDER",
      "amount": -45230,
      "balance": 1250000
    },
    {
      "date": "07-03-2026",
      "description": "TRANSFERENCIA RECIBIDA",
      "amount": 500000,
      "balance": 1295230
    }
  ],
  "balance": 1250000,
  "debug": "1. Navigating to bank homepage...\n2. Clicking 'Mi cuenta'...\n..."
}
```

## Tipos

```typescript
interface BankMovement {
  date: string;        // "dd-mm-yyyy"
  description: string; // Descripción del movimiento
  amount: number;      // Positivo = abono, Negativo = cargo
  balance: number;     // Saldo después del movimiento
}

interface ScraperOptions {
  rut: string;              // RUT del titular
  password: string;         // Clave de internet
  chromePath?: string;      // Ruta a Chrome (auto-detecta si no se provee)
  saveScreenshots?: boolean; // Guardar screenshots en ./screenshots/
  headful?: boolean;        // Chrome visible para debugging
}

interface ScrapeResult {
  success: boolean;
  movements: BankMovement[];
  balance?: number;
  error?: string;
  screenshot?: string;  // Base64 PNG
  debug?: string;       // Log paso a paso
}
```

## Cómo funciona

1. Abre Chrome headless y navega a `bancofalabella.cl`
2. Hace click en "Mi cuenta" para abrir el formulario de login
3. Ingresa RUT y clave automáticamente
4. Cierra popups/modals post-login
5. Navega a la sección "Cartola" o "Movimientos"
6. Extrae la tabla de movimientos del DOM (3 estrategias de extracción)
7. Parsea Cargo/Abono/Saldo de las columnas correctas
8. Retorna JSON limpio

## Seguridad

- **Tus credenciales nunca salen de tu máquina**. El scraper corre 100% local.
- No se envía información a ningún servidor externo excepto al portal del banco.
- Usa variables de entorno para las credenciales, nunca las hardcodees.
- El screenshot base64 puede contener información sensible — no lo compartas.

## Troubleshooting

### "No se encontró Chrome/Chromium"
Instala Chrome o pasa la ruta:
```bash
CHROME_PATH=/usr/bin/chromium banco-falabella-scraper
```

### "No se encontró el botón 'Mi cuenta'"
El banco puede haber cambiado su interfaz. Usa `--screenshots` y abre un issue.

### "El banco pide clave dinámica (2FA)"
Si tu cuenta tiene 2FA habilitado, el scraper no puede pasar ese paso automáticamente.

### Login falla sin error claro
Usa `--headful` para ver qué pasa en el browser:
```bash
FALABELLA_RUT=xxx FALABELLA_PASS=xxx banco-falabella-scraper --headful
```

### 0 movimientos extraídos
El banco puede haber cambiado la estructura del HTML. Usa `--screenshots --pretty` y revisa el `debug` log en el output.

## Automatización (cron)

```bash
# Ejemplo: sincronizar diariamente a las 7 AM
# crontab -e
0 7 * * * source /home/user/.env && /usr/local/bin/node /path/to/banco-falabella-scraper/dist/cli.js >> /var/log/falabella-sync.log 2>&1
```

O con systemd timer:
```bash
# /etc/systemd/system/falabella-sync.service
[Unit]
Description=Banco Falabella Sync

[Service]
Type=oneshot
EnvironmentFile=/home/user/.env
ExecStart=/usr/local/bin/node /path/to/dist/cli.js --pretty
StandardOutput=journal

# /etc/systemd/system/falabella-sync.timer
[Unit]
Description=Daily Falabella Sync

[Timer]
OnCalendar=*-*-* 07:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

## Integración con apps de finanzas

El output JSON es perfecto para alimentar apps de finanzas personales:

```typescript
import { scrapeFalabella } from "banco-falabella-scraper";

// Scrape
const { movements, balance } = await scrapeFalabella({
  rut: process.env.RUT!,
  password: process.env.PASS!,
});

// Guardar en tu base de datos
for (const m of movements) {
  await db.insert("transactions", {
    date: m.date,
    description: m.description,
    amount: m.amount,
    balance: m.balance,
    source: "banco-falabella",
  });
}

// Categorizar automáticamente
const categories: Record<string, string[]> = {
  "Alimentación": ["supermercado", "lider", "jumbo", "tottus"],
  "Transporte": ["uber", "didi", "copec", "shell"],
  "Servicios": ["enel", "aguas", "entel", "claro"],
};

function categorize(description: string): string {
  const desc = description.toLowerCase();
  for (const [cat, keywords] of Object.entries(categories)) {
    if (keywords.some((k) => desc.includes(k))) return cat;
  }
  return "Otros";
}
```

## Contribuir

PRs bienvenidos. Si el banco cambia su interfaz y el scraper deja de funcionar, abre un issue con el debug log y screenshots.

## License

MIT
