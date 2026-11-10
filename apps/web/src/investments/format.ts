import {
  INVESTMENT_ICONS,
  annualToMonthlyPpm,
  formatMonthShort,
  formatRatePpm,
  parsePercentToPpm,
  type InvestmentAnchorRow,
  type InvestmentDetail,
  type InvestmentIcon,
  type InvestmentRow,
  type Month,
  type MovementLite,
} from '@ff/shared';
import type { IconName } from '../components/Icon';
import { brl } from '../components/ui';

/** Textos e conversões da tela de investimentos (ADR-0012). */

/** Toda chave aceita pela API existe em `components/Icon` (conferido na compilação). */
export const ICON_CHOICES: readonly IconName[] = INVESTMENT_ICONS satisfies readonly IconName[];

export const ICON_LABELS: Record<InvestmentIcon, string> = {
  piggy: 'Cofrinho',
  shield: 'Escudo',
  home: 'Casa',
  plane: 'Avião',
  car: 'Carro',
  gift: 'Presente',
  heart: 'Coração',
  book: 'Livro',
  star: 'Estrela',
  wallet: 'Carteira',
  bank: 'Banco',
  calendar: 'Calendário',
  card: 'Cartão',
  tag: 'Etiqueta',
  clock: 'Relógio',
};

export const monthText = (m: Month) => formatMonthShort(m, true);

/** Percentual da meta já guardado (0 a 100). */
export function goalPct(r: InvestmentRow): number {
  if (!r.goalCents) return 0;
  return Math.max(0, Math.min(100, Math.round((r.grossCents / r.goalCents) * 100)));
}

/** "Chega em abr/2027", "Meta atingida", ou o aviso de que não chega. */
export function goalText(r: InvestmentRow): string {
  const g = r.goal;
  if (!r.goalCents || !g) return 'Sem meta';
  if (g.reachedNow) return 'Meta atingida';
  if (g.shortfall) {
    const s = g.shortfall.suggestedPlanCents;
    return s ? `Não chega até ${monthText(g.shortfall.goalMonth)}. Guardando ${brl(s)} por mês, chega.` : `Não chega até ${monthText(g.shortfall.goalMonth)}.`;
  }
  if (!g.reachedMonth) return 'Com o que está guardado hoje, não chega na meta.';
  return `Chega em ${monthText(g.reachedMonth)}`;
}

/** "1,2" → milionésimos ao mês; ao ano, convertido em mensal composta. null se não é número. */
export function rateInputToMonthlyPpm(text: string, unit: 'month' | 'year'): number | null {
  const ppm = parsePercentToPpm(text);
  if (ppm === null) return null;
  return unit === 'year' ? annualToMonthlyPpm(ppm / 1e6) : ppm;
}

/** "105" ou "95,5" → centésimos de ponto (10500, 9550). */
export function cdiShareInputToBp(text: string): number | null {
  const ppm = parsePercentToPpm(text);
  return ppm === null ? null : Math.round(ppm / 100);
}

export const ppmToInput = (ppm: number) => formatRatePpm(ppm).replace('%', '');
export const bpToInput = (bp: number) => (bp / 100).toFixed(2).replace(/\.?0+$/, '').replace('.', ',');

/** Movimentações e âncoras do detalhe na forma das funções puras (ordem cronológica). */
export function walkInputs(d: InvestmentDetail): { movements: MovementLite[]; anchors: Pick<InvestmentAnchorRow, 'date' | 'balanceCents'>[] } {
  return {
    movements: [...d.movements].reverse().map((m) => ({ date: m.date, kind: m.kind, amountCents: m.amountCents })),
    anchors: d.anchors.map((a) => ({ date: a.date, balanceCents: a.balanceCents })),
  };
}
