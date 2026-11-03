/**
 * Dinheiro é sempre inteiro em centavos (ADR-0004). Nunca use float para valores.
 */

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** 123456 → "R$ 1.234,56" (com espaço normal, não o NBSP do Intl). */
export function formatBRL(cents: number): string {
  return brl.format(cents / 100).replace(/ /g, ' ');
}

/** Valor com sinal explícito: "+ R$ 10,00" / "− R$ 10,00". */
export function formatSignedBRL(cents: number): string {
  if (cents === 0) return formatBRL(0);
  return `${cents > 0 ? '+' : '−'} ${formatBRL(Math.abs(cents))}`;
}

/**
 * Converte o que a pessoa digitou em centavos. Aceita "1.234,56", "1234,56",
 * "1234.56", "R$ 12", "12,5". Retorna null quando não é um número.
 */
export function parseBRL(input: string): number | null {
  let s = input.replace(/R\$|\s| /g, '').trim();
  if (!s) return null;
  const negative = s.startsWith('-') || s.startsWith('−');
  s = s.replace(/^[-−]/, '');
  if (!/^[\d.,]+$/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let intPart: string;
  let decPart = '';
  if (lastComma > -1) {
    // vírgula é o separador decimal brasileiro; pontos antes dela são milhar
    intPart = s.slice(0, lastComma).replace(/\./g, '');
    decPart = s.slice(lastComma + 1);
  } else if (lastDot > -1 && s.length - lastDot - 1 <= 2 && s.indexOf('.') === lastDot) {
    // um único ponto com até 2 casas: decimal ("12.50")
    intPart = s.slice(0, lastDot);
    decPart = s.slice(lastDot + 1);
  } else {
    intPart = s.replace(/\./g, '');
  }
  if (decPart.includes('.') || decPart.includes(',') || decPart.length > 2) return null;
  if (!/^\d*$/.test(intPart) || (intPart === '' && decPart === '')) return null;
  const cents = Number(intPart || '0') * 100 + Number((decPart + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

/** Centavos → texto para preencher um campo ("1.234,56"). */
export function centsToInput(cents: number): string {
  return formatBRL(cents).replace('R$', '').trim();
}

/**
 * Divide um total em n parcelas em centavos; o arredondamento fica na última.
 * 10000 em 3 → [3333, 3333, 3334].
 */
export function splitInstallments(totalCents: number, count: number): number[] {
  if (!Number.isInteger(count) || count < 1) throw new Error('count must be >= 1');
  const base = Math.trunc(totalCents / count);
  const parts = Array.from({ length: count }, () => base);
  parts[count - 1] = totalCents - base * (count - 1);
  return parts;
}
