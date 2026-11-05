import type { Method } from '../domain';
import { normalizeText } from './text';
import type { Direction, LineHint } from './types';

/**
 * Classificação das linhas por tabela de regras (ADR-0010, D3): dica de tipo,
 * método sugerido para criar o lançamento, explicação e se a linha é ignorada
 * por padrão. As regras olham a descrição normalizada (maiúsculas, sem acento).
 */

export interface Classification {
  hint: LineHint;
  method: Method;
  explanation: string | null;
  ignoreByDefault: boolean;
}

interface Rule {
  re: RegExp;
  hint: LineHint;
  method?: Method;
  explanation?: string;
  ignore?: boolean;
}

const METHOD_BY_HINT: Record<LineHint, Method> = {
  pix: 'pix',
  debit_card: 'debit',
  boleto: 'boleto',
  transfer: 'transfer',
  fee: 'debit',
  salary: 'transfer',
  invoice_payment: 'boleto',
  financing: 'debit',
  investment_sweep: 'transfer',
  purchase: 'credit',
  installment: 'credit',
  refund: 'credit',
  other: 'debit',
};

/** Extrato de conta (BB e OFX): a primeira regra que casar vale. */
const STATEMENT_RULES: Rule[] = [
  { re: /\bRENDE FACIL\b/, hint: 'investment_sweep', explanation: 'Aplicação/resgate automático', ignore: true },
  { re: /^(APLICACAO|RESGATE) (AUTOMATIC|POUPANCA|CDB|RDB|FUNDO)/, hint: 'investment_sweep', explanation: 'Aplicação/resgate automático', ignore: true },
  { re: /\bPAGTO\.? CARTAO( DE)? CREDITO\b|\bPAGAMENTO (DE )?FATURA\b/, hint: 'invoice_payment', explanation: 'Pagamento de fatura de cartão' },
  { re: /\bTARIFA\b|\bCOBRANCA DE I\.?O\.?F\b|\bIOF\b|\bJUROS SALDO DEVEDOR\b|\bCOBRANCA DE JUROS\b|\bENCARGOS?\b/, hint: 'fee', explanation: 'Tarifa ou encargo do banco' },
  { re: /\bBB FINAN\b|\bFINANCIAMENTO\b|\bEMPRESTIMO\b|\bCDC\b/, hint: 'financing', explanation: 'Provável parcela de financiamento' },
  { re: /\bPROVENTOS\b|\bSALARIO\b|\bFOLHA\b/, hint: 'salary', method: 'transfer' },
  { re: /\bPIX\b/, hint: 'pix' },
  { re: /\bCOMPRA COM CARTAO\b|\bCOMPRA (NO )?DEBITO\b/, hint: 'debit_card' },
  { re: /\bBOLETO\b|\bPAGAMENTO CONTA\b|\bPAGTO CONTA\b|\bCONVENIO\b/, hint: 'boleto' },
  { re: /\bTED\b|\bDOC\b|\bTRANSF/, hint: 'transfer' },
];

/** Fatura de cartão: encargos, créditos e compras. */
const INVOICE_FEE = /^(IOF\b|JUROS\b|TARIFA\b|ANUIDADE\b|ENCARGO|MULTA\b)/;

export function classifyStatement(description: string, direction: Direction): Classification {
  const norm = normalizeText(description);
  const rule = STATEMENT_RULES.find((r) => r.re.test(norm));
  const hint = rule?.hint ?? 'other';
  // Entradas sem método claro chegam, em geral, por transferência.
  const method = rule?.method ?? (direction === 'credit' && hint === 'other' ? 'transfer' : METHOD_BY_HINT[hint]);
  return { hint, method, explanation: rule?.explanation ?? null, ignoreByDefault: !!rule?.ignore };
}

export function classifyInvoice(description: string, signedCents: number, parcel: boolean): Classification {
  const norm = normalizeText(description);
  if (signedCents < 0) return { hint: 'refund', method: 'credit', explanation: 'Entra no ajuste da fatura', ignoreByDefault: true };
  if (INVOICE_FEE.test(norm)) return { hint: 'fee', method: 'credit', explanation: 'Encargo da fatura', ignoreByDefault: false };
  return { hint: parcel ? 'installment' : 'purchase', method: 'credit', explanation: null, ignoreByDefault: false };
}

/** "BANCO XP S.A" → "XP". Favorecido de boleto que é banco: pode ser a fatura de outro cartão. */
export function payeeBankOf(text: string): string | null {
  const m = /^BANCO\s+(.+?)(?:\s+S\.?\s?\/?A\.?)?$/.exec(normalizeText(text));
  return m ? m[1]!.trim() : null;
}
