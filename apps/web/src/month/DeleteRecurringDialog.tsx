import { useState } from 'react';
import { formatMonthLong, type OccurrenceRow } from '@ff/shared';
import { Button, Modal, Notice, errorText, useToast } from '../components/ui';
import { api } from '../lib/api';
import { invalidateFinance, walletUrl } from '../lib/queries';
import { ReimbursementCheckbox } from './EditOccurrenceModal';

type Scope = 'month' | 'following' | 'all';

/**
 * Excluir uma recorrente (ADR-0004, ADR-0009): a pessoa escolhe o alcance.
 * Nenhuma opção vem marcada; os erros do servidor (mês pago, fatura paga) ficam
 * no próprio diálogo, para a pessoa escolher outra opção.
 */
export function DeleteRecurringDialog({
  walletId,
  row,
  firstMonth,
  reimbursement,
  onClose,
  onDone,
}: {
  walletId: string;
  row: OccurrenceRow;
  /** Mês de início da recorrência (fora do crédito, "este e os próximos" nele = excluir tudo). */
  firstMonth: string | null;
  /** Entrada de reembolso vinculada: "Toda a recorrência" oferece excluí-la junto. */
  reimbursement?: { description: string } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [scope, setScope] = useState<Scope | null>(null);
  const [busy, setBusy] = useState(false);
  const [withReimbursement, setWithReimbursement] = useState(true);
  const alsoReimbursement = !!reimbursement && withReimbursement;
  const [err, setErr] = useState('');
  const W = walletUrl(walletId);
  const credit = row.method === 'credit' || !!row.invoice;
  const month = formatMonthLong(row.competenceMonth);
  const isFirst = !credit && firstMonth === row.competenceMonth;
  const alreadyCanceled = row.displayStatus === 'canceled';

  const options: Array<{ value: Scope; title: string; text: string; disabled?: boolean }> = [
    {
      value: 'month',
      title: 'Só este mês',
      text: alreadyCanceled
        ? 'Este mês já está excluído.'
        : credit
          ? `A cobrança da fatura de ${month.toLowerCase()} fica como Cancelado e sai do total da fatura. Os outros meses continuam.`
          : `${month} fica como Cancelado e sai dos totais. Os outros meses continuam.`,
      disabled: alreadyCanceled,
    },
    {
      value: 'following',
      title: 'Este e os próximos',
      text: isFirst
        ? 'Este é o primeiro mês: a recorrência inteira é excluída.'
        : `A recorrência termina antes de ${month.toLowerCase()}. Os meses anteriores continuam no histórico.`,
    },
    { value: 'all', title: 'Toda a recorrência', text: 'O lançamento some de todos os meses, inclusive dos anteriores.' },
  ];

  async function confirm() {
    if (!scope) return;
    setBusy(true);
    setErr('');
    try {
      if (scope === 'month') await api.post(`${W}/occurrences/${row.id}/cancel`);
      else if (scope === 'following') await api.post(`${W}/items/${row.itemId}/end`, { occurrenceId: row.id });
      else await api.del(`${W}/items/${row.itemId}${alsoReimbursement ? '?withReimbursement=1' : ''}`);
      invalidateFinance(walletId);
      toast(scope === 'month' ? 'Mês excluído.' : scope === 'following' ? 'Recorrência encerrada.' : alsoReimbursement ? 'Lançamento e reembolso excluídos.' : 'Lançamento excluído.');
      onDone();
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Excluir "${row.description}"`}
      subtitle="Lançamento recorrente"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Voltar
          </Button>
          <Button variant="primary" icon="trash" onClick={confirm} busy={busy} disabled={!scope}>
            Excluir
          </Button>
        </>
      }
    >
      <fieldset className="app-choices">
        <legend className="ff-field__label">O que você quer excluir?</legend>
        {options.map((o) => (
          <label key={o.value} className="app-choice">
            <input type="radio" name="delete-scope" value={o.value} checked={scope === o.value} disabled={o.disabled} onChange={() => setScope(o.value)} />
            <span>
              <span className="app-choice__title">{o.title}</span>
              <span className="app-choice__text">{o.text}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {scope === 'all' && <Notice tone="danger">Os meses já pagos também somem das telas e dos cards. Os pagamentos ficam guardados.</Notice>}
      {scope === 'all' && reimbursement && <ReimbursementCheckbox description={reimbursement.description} checked={withReimbursement} onChange={setWithReimbursement} />}
      {err && <Notice tone="danger">{err}</Notice>}
    </Modal>
  );
}
