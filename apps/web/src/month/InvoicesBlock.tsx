import { useState } from 'react';
import { addMonths, formatMonthShort, type AttachmentRef, type InvoiceRow } from '@ff/shared';
import { Button, ConfirmDialog, Field, Modal, MoneyInput, Notice, StatusBadge, brl, dateBR, errorText, useToast } from '../components/ui';
import { api } from '../lib/api';
import { todayISO } from '../lib/hooks';
import { invalidateFinance, walletUrl } from '../lib/queries';
import { initials } from '../pages/AccountsPage';
import { AttachmentPicker } from './AttachmentPicker';

/** Bloco "Faturas do mês" (etapa 5): uma linha por cartão, com pagar e desfazer. */
export function InvoicesBlock({ walletId, month, invoices }: { walletId: string; month: string; invoices: InvoiceRow[] }) {
  const [paying, setPaying] = useState<InvoiceRow | null>(null);
  const [undoing, setUndoing] = useState<InvoiceRow | null>(null);
  const [dates, setDates] = useState<InvoiceRow | null>(null);
  return (
    <section className="ff-card" aria-labelledby="faturas-title">
      <header className="ff-card__header">
        <h2 id="faturas-title" className="ff-card__title">
          Faturas do mês
        </h2>
        <span className="ff-caption">{invoices.length === 1 ? '1 cartão' : `${invoices.length} cartões`}</span>
      </header>
      {invoices.map((inv) => {
        const open = inv.totalCents - inv.paidCents;
        const late = inv.referenceMonth < month || inv.late;
        return (
          <div className="ff-invoice" key={inv.id}>
            <span className="ff-invoice__bank" aria-hidden="true">
              {initials(inv.account.bank)}
            </span>
            <div>
              <p className="ff-invoice__name">
                {inv.account.name}
                {inv.referenceMonth !== month && ` · ${formatMonthShort(inv.referenceMonth, true)}`}
              </p>
              <p className="ff-invoice__dates">
                Fecha {dateBR(inv.closingDate, true)} · vence {dateBR(inv.dueDate, true)}{' '}
                {inv.status === 'open' && (
                  <button type="button" className="app-linklike" style={{ fontWeight: 500, fontSize: 13 }} onClick={() => setDates(inv)}>
                    (ajustar)
                  </button>
                )}
              </p>
              {/* As compras desta fatura aparecem na tabela no mês em que foram feitas (ADR-0005). */}
              <p className="ff-invoice__dates">
                Compras de {dateBR(inv.purchasesFrom, true)} a {dateBR(inv.purchasesTo, true)}
              </p>
            </div>
            <span className="ff-invoice__amount">{brl(inv.totalCents)}</span>
            {inv.status === 'paid' ? (
              <StatusBadge status="invoice_paid" label={`Paga em ${dateBR(inv.payments.at(-1)?.paidAt, true)}`} />
            ) : inv.status === 'carried' ? (
              <StatusBadge status="invoice_carried" label={`Parcial · saldo em ${formatMonthShort(inv.carriedToMonth ?? addMonths(inv.referenceMonth, 1))}`} />
            ) : late ? (
              <StatusBadge status="late" label="Atrasada" />
            ) : (
              <StatusBadge status="invoice_open" />
            )}
            {inv.status === 'open' ? (
              <Button variant="primary" size="sm" onClick={() => setPaying(inv)} disabled={open <= 0 && inv.itemCount === 0}>
                Pagar fatura
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setUndoing(inv)}>
                Desfazer pagamento
              </Button>
            )}
          </div>
        );
      })}
      {paying && <InvoicePayModal walletId={walletId} inv={paying} onClose={() => setPaying(null)} />}
      {undoing && <UndoInvoice walletId={walletId} inv={undoing} onClose={() => setUndoing(null)} />}
      {dates && <InvoiceDatesModal walletId={walletId} inv={dates} onClose={() => setDates(null)} />}
    </section>
  );
}

function InvoicePayModal({ walletId, inv, onClose }: { walletId: string; inv: InvoiceRow; onClose: () => void }) {
  const toast = useToast();
  const [real, setReal] = useState<number | null>(inv.realAmountCents ?? inv.itemsCents);
  const [paid, setPaid] = useState<number | null>(inv.realAmountCents ?? inv.itemsCents);
  const [paidAt, setPaidAt] = useState(todayISO());
  const [files, setFiles] = useState<AttachmentRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const diff = real != null ? real - inv.itemsCents : 0;
  const rest = real != null && paid != null ? real - paid : 0;
  const next = formatMonthShort(addMonths(inv.referenceMonth, 1), true);

  async function save() {
    if (real == null || !paid) return setErr('Informe o valor da fatura e o valor pago.');
    setBusy(true);
    setErr('');
    try {
      await api.post(`${walletUrl(walletId)}/invoices/${inv.id}/payments`, { realAmountCents: real, amountCents: paid, paidAt, attachmentIds: files.map((f) => f.id) });
      invalidateFinance(walletId);
      toast(rest > 0 ? `Pagamento registrado. ${brl(rest)} foram para a fatura de ${next}.` : 'Fatura paga.');
      onClose();
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Pagar fatura"
      subtitle={`${inv.account.name} · vence ${dateBR(inv.dueDate)}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" icon="check" onClick={save} busy={busy}>
            Confirmar pagamento
          </Button>
        </>
      }
    >
      <dl className="app-kv">
        <dt>Soma dos lançamentos</dt>
        <dd>
          {brl(inv.itemsCents)} ({inv.itemCount} {inv.itemCount === 1 ? 'item' : 'itens'})
        </dd>
      </dl>
      <div className="app-grid2">
        <Field
          label="Valor da fatura (do banco)"
          htmlFor="inv-real"
          hint={inv.status === 'open' && inv.realAmountCents != null ? 'Valor da fatura importada.' : 'Confira no app ou no boleto do banco.'}
        >
          <MoneyInput id="inv-real" value={real} onChange={setReal} autoFocus />
        </Field>
        <Field label="Valor pago" htmlFor="inv-paid">
          <MoneyInput id="inv-paid" value={paid} onChange={setPaid} />
        </Field>
      </div>
      <Field label="Data do pagamento" htmlFor="inv-date">
        <input id="inv-date" type="date" className="ff-input ff-num" value={paidAt} max={todayISO()} onChange={(e) => setPaidAt(e.target.value)} />
      </Field>
      {diff !== 0 && real != null && (
        <Notice>
          A fatura veio {diff > 0 ? `${brl(diff)} acima` : `${brl(-diff)} abaixo`} do que foi lançado (anuidade, IOF ou algo não lançado). Vamos registrar a diferença como "Ajuste da fatura".
        </Notice>
      )}
      {rest > 0 && (
        <Notice>
          Faltam {brl(rest)}. Esse saldo vai automaticamente para a fatura de {next}, e esta fica como parcialmente paga.
        </Notice>
      )}
      <AttachmentPicker walletId={walletId} value={files} onChange={setFiles} />
      {err && <Notice tone="danger">{err}</Notice>}
    </Modal>
  );
}

function UndoInvoice({ walletId, inv, onClose }: { walletId: string; inv: InvoiceRow; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const last = inv.payments.at(-1);
  return (
    <ConfirmDialog
      title="Desfazer o pagamento da fatura?"
      message={`O pagamento de ${brl(last?.amountCents ?? 0)} em ${dateBR(last?.paidAt)} será removido e a fatura volta a ficar em aberto.${inv.status === 'carried' ? ' O saldo levado para a fatura seguinte também sai.' : ''}`}
      confirmLabel="Desfazer"
      busy={busy}
      error={err}
      onClose={onClose}
      onConfirm={async () => {
        if (!last) return;
        setBusy(true);
        try {
          await api.del(`${walletUrl(walletId)}/invoice-payments/${last.id}`);
          invalidateFinance(walletId);
          toast('Pagamento desfeito.');
          onClose();
        } catch (e) {
          setErr(errorText(e));
          setBusy(false);
        }
      }}
    />
  );
}

function InvoiceDatesModal({ walletId, inv, onClose }: { walletId: string; inv: InvoiceRow; onClose: () => void }) {
  const [closing, setClosing] = useState(inv.closingDate);
  const [due, setDue] = useState(inv.dueDate);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <Modal
      title="Ajustar datas desta fatura"
      subtitle={`${inv.account.name} · ${formatMonthShort(inv.referenceMonth, true)}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.patch(`${walletUrl(walletId)}/invoices/${inv.id}`, { closingDate: closing, dueDate: due });
                invalidateFinance(walletId);
                onClose();
              } catch (e) {
                setErr(errorText(e));
                setBusy(false);
              }
            }}
          >
            Salvar
          </Button>
        </>
      }
    >
      <p className="app-m0 ff-muted">Vale só para este mês. Os dias padrão do cartão ficam como estão.</p>
      <div className="app-grid2">
        <Field label="Fechamento" htmlFor="inv-close">
          <input id="inv-close" type="date" className="ff-input ff-num" value={closing} onChange={(e) => setClosing(e.target.value)} />
        </Field>
        <Field label="Vencimento" htmlFor="inv-due">
          <input id="inv-due" type="date" className="ff-input ff-num" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
      </div>
      {err && <Notice tone="danger">{err}</Notice>}
    </Modal>
  );
}

