#!/usr/bin/env node

import { scrapeFalabella } from "./scraper";

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args);

  if (flags.has("--help") || flags.has("-h")) {
    console.log(`
banco-falabella-scraper — Obtén tus movimientos bancarios como JSON

Uso:
  banco-falabella [opciones]

Opciones:
  --screenshots    Guardar screenshots en ./screenshots/
  --headful        Abrir Chrome visible (para debugging)
  --pretty         Formatear JSON con indentación
  --movements      Solo imprimir movimientos (sin metadata)
  --help, -h       Mostrar esta ayuda

Variables de entorno requeridas:
  FALABELLA_RUT    Tu RUT (ej: 123456789 o 12.345.678-9)
  FALABELLA_PASS   Tu clave de internet

Opcional:
  CHROME_PATH      Ruta al ejecutable de Chrome/Chromium

Ejemplos:
  # Básico
  FALABELLA_RUT=123456789 FALABELLA_PASS=miclave banco-falabella

  # Con archivo .env
  cp .env.example .env  # editar con tus datos
  source .env && banco-falabella --pretty

  # Solo movimientos, pipe a jq
  banco-falabella --movements | jq '.[].description'

  # Con screenshots para debugging
  banco-falabella --screenshots --pretty
`);
    process.exit(0);
  }

  const rut = process.env.FALABELLA_RUT;
  const password = process.env.FALABELLA_PASS;

  if (!rut || !password) {
    console.error(
      "Error: Se requieren las variables FALABELLA_RUT y FALABELLA_PASS\n" +
        "  Ejemplo: FALABELLA_RUT=123456789 FALABELLA_PASS=miclave banco-falabella\n" +
        "  O copia .env.example a .env y rellena tus datos."
    );
    process.exit(1);
  }

  const result = await scrapeFalabella({
    rut,
    password,
    chromePath: process.env.CHROME_PATH,
    saveScreenshots: flags.has("--screenshots"),
    headful: flags.has("--headful"),
  });

  if (!result.success) {
    console.error(`Error: ${result.error}`);
    if (result.debug) {
      console.error("\nDebug log:");
      console.error(result.debug);
    }
    process.exit(1);
  }

  const indent = flags.has("--pretty") ? 2 : undefined;

  if (flags.has("--movements")) {
    console.log(JSON.stringify(result.movements, null, indent));
  } else {
    // Remove screenshot from CLI output (too noisy)
    const { screenshot: _, ...output } = result;
    console.log(JSON.stringify(output, null, indent));
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
