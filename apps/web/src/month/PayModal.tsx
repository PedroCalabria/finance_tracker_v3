import { useMemo, useState } from 'react';
import type { AttachmentRef, OccurrenceRow } from '@ff/shared';
import { Button, Field, Modal, MoneyInput, Notice, Segmented, brl, errorText, fieldErrors, useToast } from '../components/ui';
import { api } from '../lib/api';
import { todayISO } from '../lib/hooks';
import { invalidateFinance, useItem, walletUrl } from '../lib/queries';
import { AttachmentPicker } from './AttachmentPicker';

/**
 * "Marcar como pago/recebido" (etapa 4). Data padrão hoje, valor preenchido com o
 * que falta. Abaixo do previsto, pergunta se foi desconto ou parcial. Em parcelas,
 * permite pagar as próximas junto. Se já pago, edita o último pagamento (lápis).
 */
export function PayModal({ walletId, row, onClose }: { walletId: string; row: OccurrenceRow; rows: OccurrenceRow[]; onClose: () => void }) {
  const toast = useToast();
  const editing = row.displayStatus === 'paid' ? row.payments.at(-1) : undefined;
  const income = row.type === 'income';
  const verb = income ? 'recebido' : 'pago';
  const [paidAt, setPaidAt] = useState(editing?.paidAt ?? todayISO());
  const [amount, setAmount] = useState<number | null>(editing?.amountCents ?? row.remainingCents);
  const [settlement, setSettlement] = useState<'discount' | 'partial' | null>(null);
  const [payNext, setPayNext] = useState(0);
  const [files, setFiles] = useState<AttachmentRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  // Próximas parcelas em aberto, para pagar junto.
  const item = useItem(walletId, row.form === 'installment' && !editing ? row.itemId : null);
  const nextOpen = useMemo(
    () => (item.data?.occurrences ?? []).filter((o) => (o.installmentNumber ?? 0) > (row.installmentNumber ?? 0) && o.status === 'pending'),
    [item.data, row.installmentNumber],
  );
  const multiTotal = row.remainingCents + nextOpen.slice(0, payNext).reduce((s, o) => s + o.remainingCents, 0);
  const effective = payNext > 0 ? multiTotal : amount;
  const below = !editing && payNext === 0 && amount != null && amount < row.remainingCents;

  async function save() {
    setErr(null);
    if (!effective || effective <= 0) return setErr(new Error('Informe o valor.'));
    if (below && !settlement) return setErr(new Error(`Diga se foi quitado com desconto ou se é um pagamento parcial.`));
    setBusy(true);
    try {
      if (editing) {
        await api.patch(`${walletUrl(walletId)}/payments/${editing.id}`, { paidAt, amountCents: effective });
      } else {
        await api.post(`${walletUrl(walletId)}/occurrences/${row.id}/payments`, {
          paidAt,
          amountCents: effective,
          settlement: below ? settlement : undefined,
          payNext: payNext || undefined,
          attachmentIds: files.map((f) => f.id),
        });
      }
      invalidateFinance(walletId);
      toast(editing ? 'Pagamento atualizado.' : payNext ? `${payNext + 1} parcelas marcadas como pagas.` : `Marcado como ${verb}.`);
      onClose();
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  }

  const f = fieldErrors(err);
  return (
    <Modal
      title={editing ? `Editar ${income ? 'recebimento' : 'pagamento'}` : income ? 'Marcar como recebido' : 'Marcar como pago'}
      subtitle={`${row.description}${row.installmentLabel !== 'Única' ? ` · ${row.form === 'installment' ? `parcela ${row.installmentLabel}` : row.installmentLabel}` : ''}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" icon="check" onClick={save} busy={busy}>
            {editing ? 'Salvar' : 'Confirmar'}
          </Button>
        </>
      }
    >
      <div className="app-grid2">
        <Field label={income ? 'Data do recebimento' : 'Data do pagamento'} htmlFor="pay-date" error={f.paidAt}>
          <input id="pay-date" type="date" className="ff-input ff-num" value={paidAt} max={todayISO()} onChange={(e) => setPaidAt(e.target.value)} />
        </Field>
        <Field label={income ? 'Valor recebido' : 'Valor pago'} htmlFor="pay-amount" error={f.amountCents} hint={payNext > 0 ? 'Soma das parcelas escolhidas.' : undefined}>
          {payNext > 0 ? <MoneyInput id="pay-amount" value={multiTotal} onChange={() => {}} disabled /> : <MoneyInput id="pay-amount" value={amount} onChange={setAmount} autoFocus />}
        </Field>
      </div>

      {row.form === 'installment' && !editing && nextOpen.length > 0 && (
        <Field label="Pagar também as próximas parcelas" htmlFor="pay-next">
          <select id="pay-next" className="ff-select" value={payNext} onChange={(e) => setPayNext(Number(e.target.value))}>
            <option value={0}>Não, só esta</option>
            {nextOpen.map((o, i) => (
              <option key={o.id} value={i + 1}>
                Mais {i + 1} ({nextOpen.slice(0, i + 1).map((x) => x.installmentLabel).join(', ')})
              </option>
            ))}
          </select>
        </Field>
      )}

      {below && (
        <Field label={`O valor é menor que o previsto (${brl(row.remainingCents)}). O que aconteceu?`}>
          <Segmented
            label="Tipo de pagamento"
            value={settlement ?? ('' as 'discount')}
            onChange={setSettlement}
            options={[
              { value: 'discount', label: 'Quitado com desconto' },
              { value: 'partial', label: `Parcial (faltam ${brl(row.remainingCents - (amount ?? 0))})` },
            ]}
          />
        </Field>
      )}

      {!editing && <AttachmentPicker walletId={walletId} value={files} onChange={setFiles} />}
      {err && !Object.keys(f).length ? <Notice tone="danger">{errorText(err)}</Notice> : null}
    </Modal>
  );
}
