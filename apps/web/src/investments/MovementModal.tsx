import { useMemo, useState } from 'react';
import { walkInvestment, withdrawalTax, type InvestmentRow } from '@ff/shared';
import { Button, Field, Loading, Modal, MoneyInput, Notice, brl, errorText, fieldErrors, useToast } from '../components/ui';
import { api } from '../lib/api';
import { todayISO } from '../lib/hooks';
import { invalidateInvestments, useInvestment, walletUrl } from '../lib/queries';
import { walkInputs } from './format';

/**
 * Guardar ou resgatar (ADR-0012). No resgate, a prévia do imposto sai das funções puras com o histórico da
 * caixinha; "Impostos retidos" vem preenchido com a estimativa e pode ser corrigido com o valor do banco.
 */
export function MovementModal({ walletId, inv, kind, onClose }: { walletId: string; inv: InvestmentRow; kind: 'deposit' | 'withdrawal'; onClose: () => void }) {
  const toast = useToast();
  const withdrawal = kind === 'withdrawal';
  const detail = useInvestment(walletId, withdrawal ? inv.id : null);
  const [date, setDate] = useState(todayISO());
  const [amount, setAmount] = useState<number | null>(null);
  const [tax, setTax] = useState<number | null>(null);
  const [taxEdited, setTaxEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const preview = useMemo(() => {
    if (!withdrawal || !detail.data) return null;
    const { movements, anchors } = walkInputs(detail.data);
    const walk = walkInvestment(movements, anchors, detail.data.effectiveRatePpm, date);
    const t = amount && amount > 0 ? withdrawalTax(walk, Math.min(amount, walk.grossCents), date, inv.taxMode).totalCents : 0;
    return { balance: walk.grossCents, tax: t };
  }, [withdrawal, detail.data, amount, date, inv.taxMode]);
  const taxValue = taxEdited ? tax : (preview?.tax ?? null);
  const tooMuch = withdrawal && preview != null && amount != null && amount > preview.balance;

  async function save() {
    setErr(null);
    if (!amount) return setErr(new Error(withdrawal ? 'Informe quanto vai resgatar.' : 'Informe quanto vai guardar.'));
    setBusy(true);
    try {
      await api.post(`${walletUrl(walletId)}/investments/${inv.id}/movements`, {
        date,
        kind,
        amountCents: amount,
        taxCents: withdrawal ? (taxValue ?? 0) : null,
      });
      invalidateInvestments(walletId);
      toast(withdrawal ? 'Resgate registrado.' : `Guardado em ${inv.name}.`);
      onClose();
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  }

  const f = fieldErrors(err);
  return (
    <Modal
      title={withdrawal ? `Resgatar de ${inv.name}` : `Guardar em ${inv.name}`}
      subtitle={withdrawal ? 'O valor que sai da caixinha, antes dos impostos.' : 'Registre o dinheiro que você colocou na caixinha.'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" icon="check" onClick={save} busy={busy}>
            {withdrawal ? 'Registrar resgate' : 'Guardar'}
          </Button>
        </>
      }
    >
      {withdrawal && !detail.data ? (
        <Loading />
      ) : (
        <div className="app-form">
          <div className="app-grid2">
            <Field
              label={withdrawal ? 'Valor do resgate' : 'Valor'}
              htmlFor="mv-amount"
              error={f.amountCents ?? (tooMuch ? `O saldo estimado é ${brl(preview!.balance)}.` : undefined)}
              hint={withdrawal && preview ? `Saldo estimado: ${brl(preview.balance)}` : undefined}
            >
              <MoneyInput id="mv-amount" value={amount} onChange={setAmount} autoFocus />
            </Field>
            <Field label="Data" htmlFor="mv-date" error={f.date}>
              <input id="mv-date" type="date" className="ff-input ff-num" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
          {withdrawal && (
            <>
              {inv.taxMode === 'exempt' ? (
                <p className="ff-caption app-m0">Esta caixinha é isenta de imposto.</p>
              ) : (
                <Field label="Impostos retidos" htmlFor="mv-tax" error={f.taxCents} hint="Estimativa de IR e IOF. Corrija com o valor do banco, se for diferente.">
                  <MoneyInput
                    id="mv-tax"
                    value={taxValue}
                    onChange={(v) => {
                      setTaxEdited(true);
                      setTax(v);
                    }}
                  />
                </Field>
              )}
              {amount != null && amount > 0 && !tooMuch && (
                <p className="app-m0" role="status">
                  Imposto estimado <strong className="ff-num">{brl(preview?.tax ?? 0)}</strong> · você recebe cerca de{' '}
                  <strong className="ff-num">{brl(amount - (taxValue ?? 0))}</strong>
                </p>
              )}
            </>
          )}
          {err && !Object.keys(f).length ? <Notice tone="danger">{errorText(err)}</Notice> : null}
        </div>
      )}
    </Modal>
  );
}
