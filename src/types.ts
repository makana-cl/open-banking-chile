/** Un movimiento bancario individual */
export interface BankMovement {
  /** Fecha del movimiento (formato dd-mm-yyyy o dd/mm/yyyy) */
  date: string;
  /** Descripción del movimiento */
  description: string;
  /** Monto: positivo = abono (depósito), negativo = cargo (gasto) */
  amount: number;
  /** Saldo después del movimiento */
  balance: number;
}

/** Resultado del scraping */
export interface ScrapeResult {
  /** Si el scraping fue exitoso */
  success: boolean;
  /** Lista de movimientos encontrados */
  movements: BankMovement[];
  /** Saldo actual de la cuenta */
  balance?: number;
  /** Mensaje de error si success = false */
  error?: string;
  /** Screenshot en base64 (para debugging) */
  screenshot?: string;
  /** Log de debug con pasos del scraper */
  debug?: string;
}

/** Opciones para el scraper */
export interface ScraperOptions {
  /** RUT del titular (con o sin formato, ej: "12345678-9" o "123456789") */
  rut: string;
  /** Clave de internet del banco */
  password: string;
  /** Ruta al ejecutable de Chrome/Chromium. Si no se provee, busca automáticamente. */
  chromePath?: string;
  /** Si es true, guarda screenshots en ./screenshots/ para debugging */
  saveScreenshots?: boolean;
  /** Si es true, usa headless: false (para debugging visual) */
  headful?: boolean;
}
