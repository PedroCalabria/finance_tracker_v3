import type { ISODate } from '../dates';
import type { Method } from '../domain';

/**
 * Importação de extratos e faturas (ADR-0010): tipos dos leitores puros.
 * O servidor extrai o texto do arquivo (com posição, no PDF) e os leitores
 * transformam esse texto em linhas normalizadas, sem acesso a banco nem rede.
 */

/** Trecho de texto do PDF. `y` na origem do PDF: cresce de baixo para cima. */
export interface TextItem {
  x: number;
  y: number;
  w: number;
  text: string;
}
export interface PdfPage {
  width: number;
  height: number;
  items: TextItem[];
}
export type SourceDoc = { kind: 'pdf'; pages: PdfPage[] } | { kind: 'text'; text: string };

export type Direction = 'credit' | 'debit';

export const LINE_HINTS = [
  'pix',
  'debit_card',
  'boleto',
  'transfer',
  'fee',
  'salary',
  'invoice_payment',
  'financing',
  'investment_sweep',
  'purchase',
  'installment',
  'refund',
  'other',
] as const;
export type LineHint = (typeof LINE_HINTS)[number];

export interface ImportLine {
  /** Posição na lista do arquivo (0, 1, …): é o que as decisões referenciam. */
  index: number;
  date: ISODate;
  /** Sempre positivo; o sentido diz se entrou ou saiu. */
  amountCents: number;
  direction: Direction;
  /** Como veio do banco ("Histórico 1 · Histórico 2"), já com CPF/CNPJ mascarados. */
  description: string;
  document: string | null;
  hint: LineHint;
  /** Nome sugerido para um lançamento novo (favorecido, estabelecimento). */
  name: string;
  /** Método sugerido ao criar o lançamento. */
  method: Method;
  /** Explicação curta da sugestão padrão ("Aplicação/resgate automático"). */
  explanation: string | null;
  /** Ignorar por padrão (Rende Fácil, créditos da fatura). */
  ignoreByDefault: boolean;
  /** Banco do favorecido num boleto ("XP"): pode ser a fatura de outro cartão. */
  payeeBank: string | null;
  /** Seção da fatura ("Supermercados") ou nulo. */
  section: string | null;
  /** "PARC xx/yy" da fatura. */
  parcel: { n: number; of: number } | null;
  /** Ordem (1, 2, …) entre linhas idênticas no arquivo, para a impressão digital. */
  order: number;
}

export interface ReadHeader {
  periodStart: ISODate | null;
  periodEnd: ISODate | null;
  /** Identificador bruto da conta ou cartão de origem; o servidor guarda só o hash. */
  accountRef: string | null;
  /** Forma exibível e parcial ("Conta ••93-3", "final ••12"). */
  accountLabel: string | null;
  /** Banco lido do próprio arquivo (OFX); nos PDFs vale o banco do leitor. */
  bankName: string | null;
  invoice: { dueDate: ISODate; closingDate: ISODate | null; totalCents: number } | null;
}

export interface ReadWarning {
  code: 'balance_mismatch' | 'total_mismatch';
  message: string;
  date: ISODate | null;
  diffCents: number;
}

export interface ReadResult {
  header: ReadHeader;
  lines: ImportLine[];
  warnings: ReadWarning[];
}

export interface ImportReader {
  id: string;
  /** Banco do documento ("Banco do Brasil"); no OFX, vem do arquivo. */
  bank: string;
  kind: 'statement' | 'invoice';
  /** Nome para a tela ("Extrato do Banco do Brasil"). */
  label: string;
  detect(doc: SourceDoc): boolean;
  read(doc: SourceDoc): ReadResult;
}
