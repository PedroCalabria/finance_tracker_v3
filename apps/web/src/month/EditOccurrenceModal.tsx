import { useState } from 'react';
import { METHOD_LABEL, addMonths, formatMonthShort, type OccurrenceRow } from '@ff/shared';
import { Button, ConfirmDialog, Field, Loading, Modal, MoneyInput, Notice, StatusBadge, brl, dateBR, errorText, rowBadge, useToast } from '../components/ui';
import { api } from '../lib/api';
import { invalidateFinance, useItem, walletUrl } from '../lib/queries';
import { DeleteRecurringDialog } from './DeleteRecurringDialog';
import { ItemFormModal } from './ItemFormModal';

/**
 * Detalhe de uma linha (etapas 3–5). Edita tudo do lançamento com o mesmo
 * formulário do cadastro (ADR-0004); valor, data p/ pagamento e observação são
 * deste mês. Linhas criadas pela fatura só aceitam observação.
 * Ações do item: cancelar parcelas, mover de fatura, excluir. Excluir uma
 * recorrente pergunta o alcance (só este mês, este e os próximos, toda); nos meses
 * previstos, só essa ação aparece.
 */
/** "Excluir também o reembolso": ao excluir a despesa inteira que tem entrada de reembolso vinculada. */
export function ReimbursementCheckbox({ description, checked, onChange }: { description: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="app-checkbox">
      <input type="checkbox" checked={checked} onChange={(ev) => onChange(ev.target.checked)} />
      Excluir também o reembolso ({description})
    </label>
  );
}

export function EditOccurrenceModal({ walletId, row, onClose, onPay }: { walletId: string; row: OccurrenceRow; onClose: () => void; onPay: () => void }) {
  const toast = useToast();
  const item = useItem(walletId, row.systemKind ? null : row.itemId);
  const credit = !!row.invoice || row.method === 'credit';
  const [note, setNote] = useState(row.note ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState<null | 'cancel' | 'delete' | 'move'>(null);
  // Excluir a despesa inteira: também a entrada de reembolso vinculada (padrão marcado).
  const [withReimbursement, setWithReimbursement] = useState(true);
  const reimbursement = item.data?.reimbursement ?? null;
  const system = !!row.systemKind;
  const W = walletUrl(walletId);

  async function save() {
    setBusy(true);
    setErr('');
    try {
      await api.patch(`${W}/occurrences/${row.id}`, {
        note: note !== (row.note ?? '') ? note : undefined,
        version: row.version,
      });
      invalidateFinance(walletId);
      toast('Alterações salvas.');
      onClose();
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  }

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setErr('');
    try {
      await fn();
      invalidateFinance(walletId);
      toast(done);
      onClose();
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
      setConfirm(null);
    }
  }

  const b = rowBadge(row);
  const canPay = !credit && !['paid', 'canceled'].includes(row.displayStatus);
  if (confirm === 'cancel') {
    return (
      <ConfirmDialog
        title="Cancelar as parcelas que faltam?"
        message="As parcelas futuras em aberto ficam como Cancelado. As já pagas continuam no histórico."
        confirmLabel="Cancelar parcelas"
        busy={busy}
        error={err}
        onClose={() => setConfirm(null)}
        onConfirm={() => act(() => api.post(`${W}/items/${row.itemId}/cancel`), 'Parcelas canceladas.')}
      />
    );
  }
  if (confirm === 'delete' && row.form === 'recurring') {
    return (
      <DeleteRecurringDialog
        walletId={walletId}
        row={row}
        firstMonth={item.data?.startMonth ?? null}
        reimbursement={reimbursement}
        onClose={() => setConfirm(null)}
        onDone={onClose}
      />
    );
  }
  if (confirm === 'delete') {
    return (
      <ConfirmDialog
        title={`Excluir "${row.description}"?`}
        message={
          <>
            {row.form === 'single' ? 'O lançamento some das telas.' : 'O lançamento some de todos os meses. Para manter o histórico, prefira encerrar ou cancelar as parcelas.'}
            {reimbursement && <ReimbursementCheckbox description={reimbursement.description} checked={withReimbursement} onChange={setWithReimbursement} />}
          </>
        }
        confirmLabel="Excluir"
        busy={busy}
        error={err}
        onClose={() => setConfirm(null)}
        onConfirm={() =>
          act(
            () => api.del(`${W}/items/${row.itemId}${reimbursement && withReimbursement ? '?withReimbursement=1' : ''}`),
            reimbursement && withReimbursement ? 'Lançamento e reembolso excluídos.' : 'Lançamento excluído.',
          )
        }
      />
    );
  }
  if (confirm === 'move' && row.invoice) {
    const prev = addMonths(row.invoice.referenceMonth, -1);
    const next = addMonths(row.invoice.referenceMonth, 1);
    return (
      <Modal title="Mover para outra fatura" subtitle={row.description} onClose={() => setConfirm(null)}>
        <p className="app-m0">Use quando o banco lançou a compra numa fatura diferente da calculada.</p>
        <div className="app-actions-row">
          <Button onClick={() => act(() => api.patch(`${W}/occurrences/${row.id}/invoice`, { referenceMonth: prev }), 'Movido.')} busy={busy}>
            Fatura de {formatMonthShort(prev, true)}
          </Button>
          <Button onClick={() => act(() => api.patch(`${W}/occurrences/${row.id}/invoice`, { referenceMonth: next }), 'Movido.')} busy={busy}>
            Fatura de {formatMonthShort(next, true)}
          </Button>
        </div>
        {err && <Notice tone="danger">{err}</Notice>}
      </Modal>
    );
  }

  const payButton = canPay && (
    <Button variant="secondary" icon="check" onClick={onPay} style={{ marginRight: 'auto' }}>
      {row.type === 'income' ? 'Marcar como recebido' : 'Marcar como pago'}
    </Button>
  );
  const status = (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <StatusBadge status={b.status} label={b.label} />
      {row.projected && <span className="ff-caption">Mês previsto: ao salvar, ele passa a existir.</span>}
    </div>
  );
  const paymentsList = row.payments.length > 0 && (
    <dl className="app-kv">
      {row.payments.map((p) => (
        <div key={p.id} style={{ display: 'contents' }}>
          <dt>
            {row.type === 'income' ? 'Recebido em' : 'Pago em'} {dateBR(p.paidAt)}
          </dt>
          <dd>
            {brl(p.amountCents)}
            {p.attachments.map((a) => (
              <a key={a.id} className="app-attach" style={{ marginLeft: 8 }} href={`${W}/attachments/${a.id}`} target="_blank" rel="noreferrer">
                {a.name}
              </a>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
  // Mês previsto (projeção): só "Excluir" faz sentido; o servidor grava o mês antes, se preciso.
  const actions = !system && (!row.projected || row.form === 'recurring') && (
    <div className="app-actions-row">
      {row.form === 'installment' && (
        <Button variant="ghost" size="sm" onClick={() => setConfirm('cancel')}>
          Cancelar parcelas que faltam
        </Button>
      )}
      {!row.projected && row.invoice?.status === 'open' && (
        <Button variant="ghost" size="sm" onClick={() => setConfirm('move')}>
          Mover para outra fatura
        </Button>
      )}
      <Button variant="ghost" size="sm" icon="trash" onClick={() => setConfirm('delete')}>
        Excluir
      </Button>
    </div>
  );

  if (!system) {
    if (!item.data) {
      return (
        <Modal wide title={row.description} onClose={onClose}>
          {item.isError ? <Notice tone="danger">{errorText(item.error)}</Notice> : <Loading />}
        </Modal>
      );
    }
    return (
      <ItemFormModal
        walletId={walletId}
        onClose={onClose}
        edit={{
          row,
          item: item.data,
          top: (
            <>
              {status}
              {paymentsList}
            </>
          ),
          bottom: (
            <>
              {err && <Notice tone="danger">{err}</Notice>}
              {actions}
            </>
          ),
          footerStart: payButton,
        }}
      />
    );
  }

  // Linha criada pela fatura (ajuste, saldo transferido): só a observação muda.
  return (
    <Modal
      wide
      title={row.description}
      subtitle={[row.category?.name, row.installmentLabel, METHOD_LABEL[row.method], row.account?.name].filter(Boolean).join(' · ')}
      onClose={onClose}
      footer={
        <>
          {payButton}
          <Button variant="ghost" onClick={onClose}>
            Fechar
          </Button>
          <Button variant="primary" onClick={save} busy={busy}>
            Salvar
          </Button>
        </>
      }
    >
      {status}
      {paymentsList}
      <div className="app-grid2">
        <Field label="Valor previsto" htmlFor="ed-amount" hint="Calculado pela fatura.">
          <MoneyInput id="ed-amount" value={row.expectedCents} onChange={() => {}} disabled />
        </Field>
        <Field label="Data p/ pagamento" htmlFor="ed-due" hint={credit ? 'No crédito, é o vencimento da fatura.' : undefined}>
          <input id="ed-due" type="date" className="ff-input ff-num" value={row.dueDate ?? ''} disabled readOnly />
        </Field>
      </div>
      <Field label="Observação deste mês" optional htmlFor="ed-note">
        <textarea id="ed-note" className="ff-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Ex.: veio com multa" />
      </Field>
      {err && <Notice tone="danger">{err}</Notice>}
    </Modal>
  );
}
