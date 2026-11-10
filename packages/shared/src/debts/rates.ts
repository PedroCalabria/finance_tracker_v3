/** Taxas em milionésimos da fração: 2,99% a.m. = 29900; limite de 50% a.m. */
export const MAX_MONTHLY_RATE_PPM = 500_000;

/** Converte uma taxa anual (fração, 0,12 = 12% a.a.) em mensal composta, em milionésimos. */
export function annualToMonthlyPpm(annualRate: number): number {
  return Math.round(((1 + annualRate) ** (1 / 12) - 1) * 1e6);
}

/** Taxa anual equivalente (fração) a uma mensal em milionésimos. */
export function monthlyPpmToAnnual(ppm: number): number {
  return (1 + ppm / 1e6) ** 12 - 1;
}

/** Juros de um mês sobre o saldo, arredondados ao centavo (meio para cima). `saldo × ppm` é inteiro exato. */
export function monthInterest(balanceCents: number, ratePpm: number): number {
  if (balanceCents <= 0 || ratePpm <= 0) return 0;
  return Math.round((balanceCents * ratePpm) / 1e6);
}

/** "2,99" → 29900 (até 4 casas no percentual). null se não for número. */
export function parsePercentToPpm(input: string): number | null {
  const s = input.trim().replace(/\s|%/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * 10_000);
}

/** 29900 → "2,99%"; 9489 → "0,9489%" (sem zeros à direita). */
export function formatRatePpm(ppm: number, maxDecimals = 4): string {
  const pct = ppm / 10_000;
  const fixed = pct.toFixed(maxDecimals).replace(/\.?0+$/, '');
  return `${fixed.replace('.', ',')}%`;
}
