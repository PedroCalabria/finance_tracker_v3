import { useEffect, useState } from 'react';
import { compareDates, recalcAfterExtra, type DebtPaymentKind, type DebtRow, type ExtraEffect } from '@ff/shared';
import { Button, Field, Modal, MoneyInput, Notice, Segmented, StepperInput, brl, dateBR, errorText, fieldErrors, useToast } from '../components/ui';
import { api } from '../lib/api';
import { todayISO } from '../lib/hooks';
import { invalidateDebts, walletUrl } from '../lib/queries';
import { suggestedPayment } from './format';

export interface PaymentPreset {
  amountCents: number;
  kind: DebtPaymentKind;
  effect?: ExtraEffect;
}

/**
 * "Registrar pagamento" de uma dívida (ADR-0011). A amortização extra em Price/SAC pede reduzir prazo
 * (padrão) ou parcela e mostra o contrato recalculado, editável para bater com os números do banco.
 * Não cria nada na tabela do mês.
 */
export function DebtPaymentModal({ walletId, debt, preset, onClose }: { walletId: string; debt: DebtRow; preset?: PaymentPreset; onClose: () => void }) {
  const toast = useToast();
  const contract = debt.structure === 'price' || debt.structure === 'sac';
  const [date, setDate] = useState(todayISO());
  const [amount, setAmount] = useState<number | null>(preset?.amountCents ?? suggestedPayment(debt));
  const [kind, setKind] = useState<DebtPaymentKind>(preset?.kind ?? 'installment');
  const [effect, setEffect] = useState<ExtraEffect>(preset?.effect ?? 'reduce_term');
  const [installment, setInstallment] = useState<number | null>(debt.installmentCents);
  const [remaining, setRemaining] = useState(debt.remainingInstallments != null ? String(debt.remainingInstallments) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const extraContract = kind === 'extra' && contract;
  const after = Math.max(0, debt.balanceCents - (amount ?? 0));
  const beforeAnchor = compareDates(date, debt.anchor.date) <= 0;

  // Contrato sugerido: recalculado sempre que o valor ou o efeito mudam (a pessoa pode corrigir depois).
  useEffect(() => {
    if (!extraContract) return;
    const next = recalcAfterExtra(
      { structure: debt.structure, monthlyRatePpm: debt.monthlyRatePpm, installmentCents: debt.installmentCents, remainingInstallments: debt.remainingInstallments },
      debt.balanceCents,
      after,
      effect,
    );
    setInstallment(next.installmentCents);
    setRemaining(next.remainingInstallments != null ? String(next.remainingInstallments) : '');
  }, [extraContract, effect, after, debt]);

  async function save() {
    setErr(null);
    if (!amount || amount <= 0) return setErr(new Error('Informe o valor.'));
    setBusy(true);
    try {
      await api.post(`${walletUrl(walletId)}/debts/${debt.id}/payments`, {
        date,
        amountCents: amount,
        kind,
        extraEffect: extraContract ? effect : null,
        contract: extraContract ? { installmentCents: debt.structure === 'price' ? installment : null, remainingInstallments: remaining ? Number(remaining) : null } : null,
      });
      invalidateDebts(walletId);
      toast(kind === 'extra' ? 'Amortização registrada.' : 'Pagamento registrado.');
      onClose();
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  }

  const f = fieldErrors(err);
  return (
    <Modal
      title="Registrar pagamento"
      subtitle={`${debt.name} · saldo estimado de ${brl(debt.balanceCents)}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" icon="check" onClick={save} busy={busy}>
            Registrar
          </Button>
        </>
      }
    >
      <div className="app-form">
        {debt.acceptsExtra && (
          <Field label="Tipo">
            <Segmented
              label="Tipo do pagamento"
              value={kind}
              onChange={setKind}
              options={[
                { value: 'installment', label: debt.structure === 'revolving' ? 'Mínimo / pagamento' : 'Parcela' },
                { value: 'extra', label: 'Amortização extra' },
              ]}
            />
          </Field>
        )}
        <div className="app-grid2">
          <Field label="Data do pagamento" htmlFor="dp-date" error={f.date}>
            <input id="dp-date" type="date" className="ff-input ff-num" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Valor pago" htmlFor="dp-amount" error={f.amountCents}>
            <MoneyInput id="dp-amount" value={amount} onChange={setAmount} autoFocus />
          </Field>
        </div>
        {beforeAnchor && <Notice>Já considerado no saldo de {dateBR(debt.anchor.date)}: conta no que você pagou, mas não muda o saldo estimado.</Notice>}

        {extraContract && (
          <>
            <Field label="O que a amortização faz" error={f.extraEffect}>
              <Segmented
                label="Efeito da amortização"
                value={effect}
                onChange={setEffect}
                options={[
                  { value: 'reduce_term', label: 'Reduzir prazo' },
                  { value: 'reduce_installment', label: 'Reduzir parcela' },
                ]}
              />
            </Field>
            <fieldset className="app-subform">
              <legend className="app-subform__title">Contrato depois da amortização</legend>
              <p className="ff-caption app-m0">Calculado pelo app. Se o banco informou outros números, corrija aqui.</p>
              <div className="app-grid2">
                {debt.structure === 'price' && (
                  <Field label="Parcela" htmlFor="dp-installment">
                    <MoneyInput id="dp-installment" value={installment} onChange={setInstallment} />
                  </Field>
                )}
                <Field label="Parcelas restantes" htmlFor="dp-remaining">
                  <StepperInput id="dp-remaining" value={remaining} onChange={setRemaining} min={0} max={600} incLabel="Mais uma parcela" decLabel="Menos uma parcela" />
                </Field>
              </div>
            </fieldset>
          </>
        )}
        {!beforeAnchor && amount != null && after === 0 && <Notice>Com este pagamento o saldo fica zerado. Depois, marque a dívida como quitada.</Notice>}
        {err && !Object.keys(f).length ? <Notice tone="danger">{errorText(err)}</Notice> : null}
      </div>
    </Modal>
  );
}
