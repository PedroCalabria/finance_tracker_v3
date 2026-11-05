import { daysBetween, type ISODate, type Month } from '../dates';
import { normalizeText } from './text';

/**
 * Pontuação de casamento entre uma linha importada e um lançamento do app
 * (ADR-0010, D8). Pura: o servidor monta os candidatos, isto decide.
 *
 * score = 0,55·valor + 0,25·data + 0,20·descrição (+0,3 se a parcela "xx/yy" bate)
 */

export const MATCH_THRESHOLD = 0.6;

export interface MatchLine {
  date: ISODate;
  amountCents: number;
  description: string;
  parcel?: { n: number; of: number } | null;
}

export interface MatchCandidate {
  key: string;
  /** Data p/ pagamento (extrato) ou data da compra (fatura); null = só o mês vale. */
  date: ISODate | null;
  month: Month;
  amountCents: number;
  description: string;
  /** Recorrente "o valor varia todo mês": aceita até ±50%. */
  variable: boolean;
  /** Recorrente fixa ou parcela: aceita até ±20% (vira pergunta ou aviso). */
  tolerant: boolean;
  parcel?: { n: number; of: number } | null;
}

export interface MatchScore {
  score: number;
  exactAmount: boolean;
  dayDiff: number | null;
}

/** Palavras que aparecem em quase toda linha de banco e não ajudam a casar. */
const STOPWORDS = new Set([
  'PIX', 'ENVIADO', 'RECEBIDO', 'PAGAMENTO', 'PAGTO', 'PGTO', 'BOLETO', 'COMPRA', 'COM', 'CARTAO', 'CREDITO', 'DEBITO',
  'DE', 'DA', 'DO', 'DAS', 'DOS', 'E', 'EM', 'NO', 'NA', 'PARC', 'LTDA', 'S/A', 'SA', 'ME', 'EIRELI', 'CONTA', 'TRANSF', 'TED',
]);

export function words(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .replace(/[^A-Z0-9 ]/g, ' ')
      .split(' ')
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w)),
  );
}

/** Coeficiente de Dice entre os conjuntos de palavras (0 a 1). */
export function similarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w) || [...wb].some((x) => x.length >= 4 && w.length >= 4 && (x.startsWith(w) || w.startsWith(x)))) common++;
  return Math.min(1, (2 * common) / (wa.size + wb.size));
}

function amountScore(line: number, c: MatchCandidate): number {
  if (line === c.amountCents) return 1;
  const ratio = Math.abs(line - c.amountCents) / c.amountCents;
  // Valor próximo (variável até ±50%; fixa ou parcela até ±20%): casa, mas vira pergunta ou aviso.
  if (c.variable && ratio <= 0.5) return 0.7;
  if (c.tolerant && ratio <= 0.2) return 0.7;
  return 0;
}

/** Pontua um candidato; null quando não pode casar (valor ou data fora da janela). */
export function scoreMatch(line: MatchLine, c: MatchCandidate, dayWindow: number): MatchScore | null {
  const a = amountScore(line.amountCents, c);
  if (a === 0) return null;
  let d: number;
  let dayDiff: number | null = null;
  if (c.date) {
    dayDiff = Math.abs(daysBetween(c.date, line.date));
    if (dayDiff > dayWindow) return null;
    d = 1 - dayDiff / (dayWindow + 1);
  } else {
    if (c.month !== line.date.slice(0, 7)) return null;
    d = 0.5;
  }
  const parcelBonus = line.parcel && c.parcel && line.parcel.n === c.parcel.n && line.parcel.of === c.parcel.of ? 0.3 : 0;
  const score = Math.min(1, 0.55 * a + 0.25 * d + 0.2 * similarity(line.description, c.description) + parcelBonus);
  return { score, exactAmount: a === 1, dayDiff };
}

export interface Assignment {
  best: { key: string; score: MatchScore } | null;
  alternatives: Array<{ key: string; score: MatchScore }>;
}

/**
 * Atribuição gulosa: pares (linha, candidato) do maior para o menor score; cada
 * candidato serve a uma linha só. As 3 melhores sobras de cada linha viram alternativas.
 */
export function assignMatches(perLine: Map<number, Array<{ key: string; score: MatchScore }>>): Map<number, Assignment> {
  const pairs: Array<{ line: number; key: string; score: MatchScore }> = [];
  for (const [line, cands] of perLine) for (const c of cands) pairs.push({ line, ...c });
  pairs.sort((x, y) => y.score.score - x.score.score || x.line - y.line);
  const used = new Set<string>();
  const out = new Map<number, Assignment>();
  for (const line of perLine.keys()) out.set(line, { best: null, alternatives: [] });
  for (const p of pairs) {
    const a = out.get(p.line)!;
    if (a.best || used.has(p.key) || p.score.score < MATCH_THRESHOLD) continue;
    a.best = { key: p.key, score: p.score };
    used.add(p.key);
  }
  for (const [line, cands] of perLine) {
    const a = out.get(line)!;
    a.alternatives = cands
      .filter((c) => c.key !== a.best?.key && c.score.score >= 0.35)
      .sort((x, y) => y.score.score - x.score.score)
      .slice(0, 3);
  }
  return out;
}
