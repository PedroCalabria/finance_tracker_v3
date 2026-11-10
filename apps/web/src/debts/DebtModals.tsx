import { useMemo, useState } from 'react';
import { formatMonthLong, formatMonthShort, whatIfExtra, type DebtBudgetRow, type DebtPaymentRow, type DebtRow, type ExtraEffect, type WhatIfScenario } from '@ff/shared';
import { Button, ConfirmDialog, Field, IconButton, Loading, Modal, MoneyInput, MonthInput, Notice, Segmented, StepperInput, brl, dateBR, errorText, fieldErrors, useToast } from '../components/ui';
import { api } from '../lib/api';
import { todayISO } from '../lib/hooks';
import { invalidateDebts, useDebt, useDebtBudgets, walletUrl } from '../lib/queries';
import { kicker, obligationLabel, rateLabel, termsOf } from './format';
import type { PaymentPreset } from './DebtPaymentModal';

/** Modais da tela de dívidas (ADR-0011): atualizar saldo, simular amortização, orçamento, quitar e detalhes. */

function useSubmit(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      onDone();
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  };
  return { busy, err, setErr, run };
}

const footer = (onClose: () => void, onSave: () => void, busy: boolean, label = 'Salvar') => (
  <>
    <Button variant="ghost" onClick={onClose}>
      Cancelar
    </Button>
    <Button variant="primary" icon="check" onClick={onSave} busy={busy}>
      {label}
    </Button>
  </>
);

// ---------- Atualizar saldo

export function BalanceAnchorModal({ walletId, debt, onClose }: { walletId: string; debt: DebtRow; onClose: () => void }) {
  const toast = useToast();
  const contract = debt.structure === 'price' || debt.structure === 'sac';
  const [date, setDate] = useState(todayISO());
  const [balance, setBalance] = useState<number | null>(debt.balanceCents);
  const [remaining, setRemaining] = useState(debt.remainingInstallments != null ? String(debt.remainingInstallments) : '');
  const [installment, setInstallment] = useState<number | null>(debt.installmentCents);
  const { busy, err, setErr, run } = useSubmit(() => {
    invalidateDebts(walletId);
    toast('Saldo atualizado.');
    onClose();
  });
  const save = () => {
    if (balance == null) return setErr(new Error('Informe o saldo.'));
    void run(() =>
      api.post(`${walletUrl(walletId)}/debts/${debt.id}/anchors`, {
        date,
        balanceCents: balance,
        remainingInstallments: contract && remaining ? Number(remaining) : null,
        installmentCents: debt.structure === 'price' ? installment : null,
      }),
    );
  };
  const f = fieldErrors(err);
  return (
    <Modal title="Atualizar saldo" subtitle={`${debt.name} · o saldo informado corrige a estimativa do app`} onClose={onClose} footer={footer(onClose, save, busy)}>
      <div className="app-form">
        <div className="app-grid2">
          <Field label="Saldo devedor" htmlFor="an-balance" error={f.balanceCents} hint="Como aparece no app do banco.">
            <MoneyInput id="an-balance" value={balance} onChange={setBalance} autoFocus />
          </Field>
          <Field label="Data do saldo" htmlFor="an-date" error={f.date}>
            <input id="an-date" type="date" className="ff-input ff-num" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        {contract && (
          <div className="app-grid2">
            <Field label="Parcelas restantes" htmlFor="an-remaining" error={f.remainingInstallments}>
              <StepperInput id="an-remaining" value={remaining} onChange={setRemaining} min={1} max={600} incLabel="Mais uma parcela" decLabel="Menos uma parcela" />
            </Field>
            {debt.structure === 'price' && (
              <Field label="Parcela" htmlFor="an-installment" error={f.installmentCents}>
                <MoneyInput id="an-installment" value={installment} onChange={setInstallment} />
              </Field>
            )}
          </div>
        )}
        {err && !Object.keys(f).length ? <Notice tone="danger">{errorText(err)}</Notice> : null}
      </div>
    </Modal>
  );
}

// ---------- E se eu amortizar R$ X?

const monthsText = (n: number | null) => (n === null ? 'não quita' : n === 1 ? '1 mês' : `${n} meses`);

export function WhatIfModal({ debt, onClose, onRegister }: { debt: DebtRow; onClose: () => void; onRegister: (p: PaymentPreset) => void }) {
  const [amount, setAmount] = useState<number | null>(null);
  const tooMuch = amount != null && amount > debt.balanceCents;
  const result = useMemo(() => (amount && amount > 0 && !tooMuch ? whatIfExtra(termsOf(debt), debt.balanceCents, amount) : null), [amount, tooMuch, debt]);
  const rows: Array<{ label: string; s: WhatIfScenario; effect?: ExtraEffect }> = result
    ? result.single
      ? [{ label: 'Amortizando', s: result.single }]
      : [
          { label: 'Reduzindo o prazo', s: result.reduceTerm!, effect: 'reduce_term' },
          { label: 'Reduzindo a parcela', s: result.reduceInstallment!, effect: 'reduce_installment' },
        ]
    : [];
  const showInstallment = debt.structure !== 'revolving';
  return (
    <Modal wide title="E se eu amortizar?" subtitle={`${debt.name} · saldo estimado de ${brl(debt.balanceCents)} · ${rateLabel(debt.monthlyRatePpm)}`} onClose={onClose}>
      <div className="app-form">
        <Field label="Valor da amortização" htmlFor="wi-amount" error={tooMuch ? `O valor passa do saldo de ${brl(debt.balanceCents)}.` : undefined} hint="Só simula: nada é gravado.">
          <MoneyInput id="wi-amount" value={amount} onChange={setAmount} autoFocus />
        </Field>
        {result && (
          <div className="ff-table-wrap">
            <table className="ff-table app-whatif">
              <caption className="app-sr">Comparação da amortização</caption>
              <thead>
                <tr>
                  <th scope="col">Cenário</th>
                  {showInstallment && <th scope="col" className="is-num">{debt.structure === 'sac' ? 'Amortização' : 'Parcela'}</th>}
                  <th scope="col" className="is-num">Prazo</th>
                  <th scope="col" className="is-num">Juros</th>
                  <th scope="col" className="is-num">Economia</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Sem amortizar</th>
                  {showInstallment && <td className="is-num">{result.baseline.installmentCents != null ? brl(result.baseline.installmentCents) : '—'}</td>}
                  <td className="is-num">{monthsText(result.baseline.months)}</td>
                  <td className="is-num">{result.baseline.months === null ? '—' : brl(result.baseline.interestCents)}</td>
                  <td className="is-num">—</td>
                </tr>
                {rows.map(({ label, s }) => (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    {showInstallment && <td className="is-num">{s.installmentCents != null ? brl(s.installmentCents) : '—'}</td>}
                    <td className="is-num">{monthsText(s.months)}</td>
                    <td className="is-num">{s.months === null ? '—' : brl(s.interestCents)}</td>
                    <td className="is-num">
                      {s.months === null || result.baseline.months === null ? '—' : brl(Math.max(0, s.interestSavedCents))}
                      {s.monthsSaved ? <small className="app-block ff-muted">{monthsText(s.monthsSaved)} a menos</small> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result && (
          <div className="app-actions-row">
            {rows.map(({ label, effect }) => (
              <Button key={label} size="sm" variant={effect === 'reduce_installment' ? 'secondary' : 'primary'} onClick={() => onRegister({ amountCents: amount!, kind: 'extra', effect })}>
                {rows.length > 1 ? `Registrar ${label.toLowerCase()}` : 'Registrar esta amortização'}
              </Button>
            ))}
          </div>
        )}
        {result && result.baseline.months === null && <Notice>Pagando só o contrato, esta dívida não quita em 50 anos.</Notice>}
      </div>
    </Modal>
  );
}

// ---------- Orçamento

export function BudgetModal({ walletId, currentMonth, onClose }: { walletId: string; currentMonth: string; onClose: () => void }) {
  const toast = useToast();
  const budgets = useDebtBudgets(walletId);
  const [from, setFrom] = useState(currentMonth);
  const [amount, setAmount] = useState<number | null>(null);
  const { busy, err, setErr, run } = useSubmit(() => {
    invalidateDebts(walletId);
    toast('Orçamento salvo.');
    onClose();
  });
  const save = () => {
    if (amount == null) return setErr(new Error('Informe o valor.'));
    void run(() => api.put(`${walletUrl(walletId)}/debt-budgets/${from}`, { amountCents: amount }));
  };
  async function remove(b: DebtBudgetRow) {
    try {
      await api.del(`${walletUrl(walletId)}/debt-budgets/${b.fromMonth}`);
      invalidateDebts(walletId);
    } catch (e) {
      setErr(e);
    }
  }
  const f = fieldErrors(err);
  return (
    <Modal title="Orçamento para dívidas" subtitle="Quanto você consegue destinar às dívidas por mês, já com as parcelas e os mínimos" onClose={onClose} footer={footer(onClose, save, busy)}>
      <div className="app-form">
        <div className="app-grid2">
          <Field label="A partir de" htmlFor="bg-month">
            <MonthInput id="bg-month" value={from} onChange={setFrom} label="A partir de" />
          </Field>
          <Field label="Valor por mês" htmlFor="bg-amount" error={f.amountCents}>
            <MoneyInput id="bg-amount" value={amount} onChange={setAmount} autoFocus />
          </Field>
        </div>
        <p className="ff-caption app-m0">Vale do mês escolhido até a próxima mudança. Os meses anteriores continuam como estavam.</p>
        {budgets.data && budgets.data.length > 0 && (
          <div>
            <p className="ff-field__label">Orçamentos gravados</p>
            <ul className="app-plain-list">
              {[...budgets.data].reverse().map((b) => (
                <li key={b.fromMonth} className="app-plain-list__row">
                  <span>
                    A partir de {formatMonthLong(b.fromMonth).toLowerCase()}: <strong className="ff-num">{brl(b.amountCents)}</strong>
                  </span>
                  <IconButton icon="trash" label={`Remover o orçamento a partir de ${formatMonthShort(b.fromMonth, true)}`} onClick={() => remove(b)} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {err && !Object.keys(f).length ? <Notice tone="danger">{errorText(err)}</Notice> : null}
      </div>
    </Modal>
  );
}

// ---------- Marcar como quitada

export function PayOffModal({ walletId, debt, onClose }: { walletId: string; debt: DebtRow; onClose: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState(todayISO());
  const [finalPayment, setFinalPayment] = useState(debt.balanceCents > 0);
  const { busy, err, run } = useSubmit(() => {
    invalidateDebts(walletId);
    toast('Dívida quitada. Parabéns!');
    onClose();
  });
  const f = fieldErrors(err);
  return (
    <Modal
      title="Marcar como quitada"
      subtitle={debt.name}
      onClose={onClose}
      footer={footer(onClose, () => void run(() => api.post(`${walletUrl(walletId)}/debts/${debt.id}/pay-off`, { date, finalPayment })), busy, 'Quitar')}
    >
      <div className="app-form">
        <Field label="Data da quitação" htmlFor="po-date" error={f.date}>
          <input id="po-date" type="date" className="ff-input ff-num" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
        </Field>
        {debt.balanceCents > 0 && (
          <label className="app-checkbox">
            <input type="checkbox" checked={finalPayment} onChange={(e) => setFinalPayment(e.target.checked)} />
            Registrar o pagamento final de {brl(debt.balanceCents)}
          </label>
        )}
        <p className="ff-caption app-m0">A dívida sai da simulação e vai para "Quitadas", com o histórico.</p>
        {err && !Object.keys(f).length ? <Notice tone="danger">{errorText(err)}</Notice> : null}
      </div>
    </Modal>
  );
}

// ---------- Detalhes: histórico de saldos e pagamentos

const KIND_LABEL = { installment: 'Parcela', extra: 'Amortização extra' } as const;
const EFFECT_LABEL = { reduce_term: 'reduziu o prazo', reduce_installment: 'reduziu a parcela' } as const;

export function DebtDetailModal({ walletId, debtId, onClose }: { walletId: string; debtId: string; onClose: () => void }) {
  const toast = useToast();
  const q = useDebt(walletId, debtId);
  const [editing, setEditing] = useState<DebtPaymentRow | null>(null);
  const [removing, setRemoving] = useState<DebtPaymentRow | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const d = q.data;

  async function removeAnchor(id: string) {
    setErr(null);
    try {
      await api.del(`${walletUrl(walletId)}/debts/${debtId}/anchors/${id}`);
      invalidateDebts(walletId);
      toast('Saldo removido.');
    } catch (e) {
      setErr(e);
    }
  }

  return (
    <Modal wide title={d?.name ?? 'Dívida'} subtitle={d ? kicker(d) : undefined} onClose={onClose}>
      {!d ? (
        <Loading />
      ) : (
        <div className="app-form">
          <dl className="app-kv">
            <dt>Saldo estimado</dt>
            <dd>{brl(d.balanceCents)}</dd>
            <dt>Saldo inicial</dt>
            <dd>
              {brl(d.initial.balanceCents)} em {dateBR(d.initial.date)}
            </dd>
            <dt>Taxa</dt>
            <dd>{rateLabel(d.monthlyRatePpm)}</dd>
            {obligationLabel(d) && (
              <>
                <dt>Contrato</dt>
                <dd>
                  {obligationLabel(d)}
                  {d.remainingInstallments != null ? ` · ${d.remainingInstallments} restantes` : ''}
                </dd>
              </>
            )}
            <dt>Pago até agora</dt>
            <dd>{brl(d.paidCents)}</dd>
            {d.paidOffOn && (
              <>
                <dt>Quitada em</dt>
                <dd>{dateBR(d.paidOffOn)}</dd>
              </>
            )}
          </dl>

          <section aria-labelledby="dd-pay">
            <h3 id="dd-pay" className="app-section-title">
              Pagamentos
            </h3>
            {d.payments.length === 0 ? (
              <p className="ff-muted app-m0">Nenhum pagamento registrado.</p>
            ) : (
              <ul className="app-plain-list">
                {d.payments.map((p) => (
                  <li key={p.id} className="app-plain-list__row">
                    <span>
                      <strong className="ff-num">{brl(p.amountCents)}</strong> em {dateBR(p.date)} · {KIND_LABEL[p.kind]}
                      {p.extraEffect ? ` (${EFFECT_LABEL[p.extraEffect]})` : ''}
                      {p.beforeAnchor && <small className="app-block ff-muted">Já considerado no saldo informado</small>}
                    </span>
                    <span className="app-actions-row">
                      <IconButton icon="pencil" label={`Editar pagamento de ${dateBR(p.date)}`} onClick={() => setEditing(p)} />
                      <IconButton icon="trash" label={`Excluir pagamento de ${dateBR(p.date)}`} onClick={() => setRemoving(p)} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="dd-anchors">
            <h3 id="dd-anchors" className="app-section-title">
              Saldos informados
            </h3>
            <ul className="app-plain-list">
              {d.anchors.map((a, i) => (
                <li key={a.id} className="app-plain-list__row">
                  <span>
                    <strong className="ff-num">{brl(a.balanceCents)}</strong> em {dateBR(a.date)}
                    {i === 0 && <small className="app-block ff-muted">Saldo vigente</small>}
                    {i === d.anchors.length - 1 && d.anchors.length > 1 && <small className="app-block ff-muted">Saldo inicial</small>}
                  </span>
                  {d.anchors.length > 1 && <IconButton icon="trash" label={`Remover o saldo de ${dateBR(a.date)}`} onClick={() => removeAnchor(a.id)} />}
                </li>
              ))}
            </ul>
          </section>
          {err ? <Notice tone="danger">{errorText(err)}</Notice> : null}
        </div>
      )}
      {editing && d && <PaymentEditModal walletId={walletId} debt={d} payment={editing} onClose={() => setEditing(null)} />}
      {removing && d && (
        <RemovePaymentDialog walletId={walletId} debtId={d.id} payment={removing} onClose={() => setRemoving(null)} />
      )}
    </Modal>
  );
}

const contractWarning = 'O contrato (parcela e prazo) não volta sozinho. Se precisar, ajuste em Editar dívida.';

function RemovePaymentDialog({ walletId, debtId, payment, onClose }: { walletId: string; debtId: string; payment: DebtPaymentRow; onClose: () => void }) {
  const toast = useToast();
  const { busy, err, run } = useSubmit(() => {
    invalidateDebts(walletId);
    toast('Pagamento excluído.');
    onClose();
  });
  return (
    <ConfirmDialog
      title="Excluir pagamento"
      message={`Excluir o pagamento de ${brl(payment.amountCents)} em ${dateBR(payment.date)}?${payment.kind === 'extra' ? ` ${contractWarning}` : ''}`}
      confirmLabel="Excluir"
      busy={busy}
      error={err ? errorText(err) : undefined}
      onClose={onClose}
      onConfirm={() => void run(() => api.del(`${walletUrl(walletId)}/debts/${debtId}/payments/${payment.id}`))}
    />
  );
}

function PaymentEditModal({ walletId, debt, payment, onClose }: { walletId: string; debt: DebtRow; payment: DebtPaymentRow; onClose: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState(payment.date);
  const [amount, setAmount] = useState<number | null>(payment.amountCents);
  const [kind, setKind] = useState(payment.kind);
  const { busy, err, setErr, run } = useSubmit(() => {
    invalidateDebts(walletId);
    toast('Pagamento atualizado.');
    onClose();
  });
  const save = () => {
    if (!amount) return setErr(new Error('Informe o valor.'));
    void run(() => api.put(`${walletUrl(walletId)}/debts/${debt.id}/payments/${payment.id}`, { date, amountCents: amount, kind, version: payment.version }));
  };
  const f = fieldErrors(err);
  return (
    <Modal title="Editar pagamento" subtitle={debt.name} onClose={onClose} footer={footer(onClose, save, busy)}>
      <div className="app-form">
        {debt.acceptsExtra && (
          <Segmented
            label="Tipo do pagamento"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'installment', label: 'Parcela' },
              { value: 'extra', label: 'Amortização extra' },
            ]}
          />
        )}
        <div className="app-grid2">
          <Field label="Data" htmlFor="pe-date" error={f.date}>
            <input id="pe-date" type="date" className="ff-input ff-num" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Valor" htmlFor="pe-amount" error={f.amountCents}>
            <MoneyInput id="pe-amount" value={amount} onChange={setAmount} />
          </Field>
        </div>
        {payment.kind === 'extra' && <Notice>{contractWarning}</Notice>}
        {err && !Object.keys(f).length ? <Notice tone="danger">{errorText(err)}</Notice> : null}
      </div>
    </Modal>
  );
}
