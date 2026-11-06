import { formatMonthShort, type Month } from './dates';
import type { ItemForm } from './domain';

/**
 * Edição estrutural com pagamentos (ADR-0004): a ocorrência paga é mantida e
 * reposicionada no lugar equivalente da sequência nova. Esta regra diz onde
 * cada uma vai parar, ou por que não há lugar. Usada pelo servidor (`rebuild`)
 * e pelo aviso do formulário.
 */

/** Uma ocorrência com pagamento, como está hoje. */
export interface PaidSlot {
  competenceMonth: Month;
  installmentNumber: number | null;
}

/** A sequência que a edição vai gravar. */
export type NewSequence =
  | { form: 'single' }
  /** `months[k]` = mês da parcela k + 1. */
  | { form: 'installment'; months: Month[] }
  | { form: 'recurring'; startMonth: Month; endMonth: Month | null };

/**
 * Destino de uma ocorrência paga:
 * - única: `{ installmentNumber: null, competenceMonth: null }` (o mês sai da data da compra);
 * - parcela: número e mês dela;
 * - recorrente: o mês.
 */
export interface PaidTarget {
  installmentNumber: number | null;
  competenceMonth: Month | null;
}

export type PaidTargetsResult = { ok: true; targets: PaidTarget[] } | { ok: false; message: string };

export interface PaidTargetsInput {
  fromForm: ItemForm;
  typeChanged: boolean;
  toCredit: boolean;
  paid: PaidSlot[];
  to: NewSequence;
}

const m = (month: Month) => formatMonthShort(month, true);

export function paidTargets(input: PaidTargetsInput): PaidTargetsResult {
  const { paid, to } = input;
  if (paid.length === 0) return { ok: true, targets: [] };
  if (input.typeChanged) {
    return { ok: false, message: 'Este lançamento já tem pagamento. Para trocar entre despesa e entrada, desfaça o pagamento antes ou cadastre de novo.' };
  }
  if (input.toCredit) {
    return { ok: false, message: 'Este lançamento já tem pagamento, e no crédito tudo passa pela fatura. Desfaça o pagamento antes ou cadastre de novo.' };
  }

  const targets: PaidTarget[] = [];
  // Em ordem cronológica, para a mensagem citar o primeiro mês problemático.
  const ordered = [...paid].sort((a, b) => (a.competenceMonth < b.competenceMonth ? -1 : a.competenceMonth > b.competenceMonth ? 1 : 0));
  if (to.form === 'single') {
    if (paid.length > 1) {
      return { ok: false, message: 'Este lançamento tem mais de um mês pago e não cabe numa compra única. Desfaça os pagamentos antes ou cadastre de novo.' };
    }
    return { ok: true, targets: [{ installmentNumber: null, competenceMonth: null }] };
  }
  for (const p of ordered) {
    if (to.form === 'recurring') {
      if (p.competenceMonth < to.startMonth) {
        return { ok: false, message: `O mês pago de ${m(p.competenceMonth)} ficaria antes do novo mês de início. Comece até ${m(p.competenceMonth)} ou desfaça o pagamento.` };
      }
      if (to.endMonth && p.competenceMonth > to.endMonth) {
        return { ok: false, message: `O mês pago de ${m(p.competenceMonth)} ficaria depois do fim da recorrência. Desfaça o pagamento antes ou cadastre de novo.` };
      }
      targets.push({ installmentNumber: null, competenceMonth: p.competenceMonth });
    } else if (input.fromForm === 'installment' && p.installmentNumber) {
      const n = p.installmentNumber;
      if (n > to.months.length) {
        return { ok: false, message: `A parcela ${n} já foi paga e deixaria de existir. Mantenha pelo menos ${n} parcelas ou desfaça o pagamento.` };
      }
      targets.push({ installmentNumber: n, competenceMonth: to.months[n - 1]! });
    } else {
      const k = to.months.indexOf(p.competenceMonth);
      if (k < 0) {
        return { ok: false, message: `O pagamento de ${m(p.competenceMonth)} não teria parcela no mesmo mês. Ajuste a data da 1ª parcela ou desfaça o pagamento.` };
      }
      targets.push({ installmentNumber: k + 1, competenceMonth: p.competenceMonth });
    }
  }
  const keys = targets.map((t) => (t.installmentNumber ? `#${t.installmentNumber}` : t.competenceMonth));
  if (new Set(keys).size !== keys.length) {
    return { ok: false, message: 'Dois pagamentos cairiam no mesmo mês. Desfaça um deles antes ou cadastre de novo.' };
  }
  // Devolve na ordem recebida.
  return { ok: true, targets: paid.map((p) => targets[ordered.indexOf(p)]!) };
}
