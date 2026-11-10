import { useMemo, useState } from 'react';
import {
  INVESTMENT_KIND_LABELS,
  TAX_MODE_LABELS,
  formatYield,
  parsePercentToPpm,
  walkInvestment,
  withdrawalTax,
  type InvestmentMovementRow,
  type InvestmentRow,
  type InvestmentSettings,
} from '@ff/shared';
import { Button, ConfirmDialog, Field, IconButton, Loading, Modal, MoneyInput, Notice, brl, dateBR, errorText, fieldErrors, useToast } from '../components/ui';
import { api } from '../lib/api';
import { todayISO } from '../lib/hooks';
import { invalidateInvestments, useInvestment, walletUrl } from '../lib/queries';
import { goalText, ppmToInput, walkInputs } from './format';

/** Modais da tela de investimentos (ADR-0012): atualizar saldo, encerrar, excluir, CDI e detalhes. */

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

const fallback = (err: unknown, f: Record<string, string>) => (err && !Object.keys(f).length ? <Notice tone="danger">{errorText(err)}</Notice> : null);

// ---------- Atualizar saldo

export function AnchorModal({ walletId, inv, onClose }: { walletId: string; inv: InvestmentRow; onClose: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState(todayISO());
  const [balance, setBalance] = useState<number | null>(inv.grossCents);
  const { busy, err, setErr, run } = useSubmit(() => {
    invalidateInvestments(walletId);
    toast('Saldo atualizado.');
    onClose();
  });
  const save = () => {
    if (balance == null) return setErr(new Error('Informe o saldo.'));
    void run(() => api.post(`${walletUrl(walletId)}/investments/${inv.id}/anchors`, { date, balanceCents: balance }));
  };
  const f = fieldErrors(err);
  return (
    <Modal title="Atualizar saldo" subtitle={`${inv.name} · o saldo do banco corrige a estimativa do app`} onClose={onClose} footer={footer(onClose, save, busy)}>
      <div className="app-form">
        <div className="app-grid2">
          <Field label="Saldo na caixinha" htmlFor="ia-balance" error={f.balanceCents} hint="Como aparece no app do banco (valor bruto).">
            <MoneyInput id="ia-balance" value={balance} onChange={setBalance} autoFocus />
          </Field>
          <Field label="Data do saldo" htmlFor="ia-date" error={f.date}>
            <input id="ia-date" type="date" className="ff-input ff-num" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        {fallback(err, f)}
      </div>
    </Modal>
  );
}

// ---------- Encerrar

export function CloseModal({ walletId, inv, onClose }: { walletId: string; inv: InvestmentRow; onClose: () => void }) {
  const toast = useToast();
  const detail = useInvestment(walletId, inv.id);
  const [date, setDate] = useState(todayISO());
  const [amount, setAmount] = useState<number | null>(null);
  const [tax, setTax] = useState<number | null>(null);
  const estimate = useMemo(() => {
    if (!detail.data) return null;
    const { movements, anchors } = walkInputs(detail.data);
    const walk = walkInvestment(movements, anchors, detail.data.effectiveRatePpm, date);
    return { gross: walk.grossCents, tax: withdrawalTax(walk, walk.grossCents, date, inv.taxMode).totalCents };
  }, [detail.data, date, inv.taxMode]);
  const amountValue = amount ?? estimate?.gross ?? null;
  const taxValue = tax ?? estimate?.tax ?? null;
  const { busy, err, run } = useSubmit(() => {
    invalidateInvestments(walletId);
    toast('Caixinha encerrada.');
    onClose();
  });
  const save = () => void run(() => api.post(`${walletUrl(walletId)}/investments/${inv.id}/close`, { date, amountCents: amountValue, taxCents: inv.taxMode === 'exempt' ? 0 : taxValue }));
  const f = fieldErrors(err);
  return (
    <Modal title={`Encerrar ${inv.name}`} subtitle="Registra o resgate de tudo e move a caixinha para Encerradas. Dá para reabrir." onClose={onClose} footer={footer(onClose, save, busy, 'Encerrar')}>
      {!estimate ? (
        <Loading />
      ) : (
        <div className="app-form">
          <div className="app-grid2">
            <Field label="Valor resgatado" htmlFor="ic-amount" error={f.amountCents} hint={`Saldo estimado: ${brl(estimate.gross)}`}>
              <MoneyInput id="ic-amount" value={amountValue} onChange={setAmount} />
            </Field>
            <Field label="Data" htmlFor="ic-date" error={f.date}>
              <input id="ic-date" type="date" className="ff-input ff-num" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
          {inv.taxMode !== 'exempt' && (
            <Field label="Impostos retidos" htmlFor="ic-tax" error={f.taxCents} hint="Estimativa de IR e IOF. Corrija com o valor do banco, se for diferente.">
              <MoneyInput id="ic-tax" value={taxValue} onChange={setTax} />
            </Field>
          )}
          {amountValue != null && (
            <p className="app-m0" role="status">
              Você recebe cerca de <strong className="ff-num">{brl(amountValue - (inv.taxMode === 'exempt' ? 0 : (taxValue ?? 0)))}</strong>
            </p>
          )}
          {fallback(err, f)}
        </div>
      )}
    </Modal>
  );
}

// ---------- Excluir

export function DeleteInvestmentDialog({ walletId, inv, onClose }: { walletId: string; inv: InvestmentRow; onClose: () => void }) {
  const toast = useToast();
  const { busy, err, run } = useSubmit(() => {
    invalidateInvestments(walletId);
    toast('Caixinha excluída.');
    onClose();
  });
  return (
    <ConfirmDialog
      title={`Excluir ${inv.name}?`}
      message="A caixinha some da tela e do balanço do mês, com todo o histórico. Para guardar o histórico, prefira Encerrar."
      confirmLabel="Excluir"
      busy={busy}
      error={err ? errorText(err) : undefined}
      onClose={onClose}
      onConfirm={() => void run(() => api.del(`${walletUrl(walletId)}/investments/${inv.id}`))}
    />
  );
}

// ---------- CDI

export function CdiModal({ walletId, settings, onClose }: { walletId: string; settings: InvestmentSettings; onClose: () => void }) {
  const toast = useToast();
  const [text, setText] = useState(settings.cdiAnnualPpm ? ppmToInput(settings.cdiAnnualPpm) : '');
  const { busy, err, setErr, run } = useSubmit(() => {
    invalidateInvestments(walletId);
    toast('CDI atualizado.');
    onClose();
  });
  const save = () => {
    const ppm = parsePercentToPpm(text);
    if (!ppm) return setErr(new Error('Informe o CDI ao ano (por exemplo, 14,9).'));
    void run(() => api.put(`${walletUrl(walletId)}/investment-settings`, { cdiAnnualPpm: ppm }));
  };
  const f = fieldErrors(err);
  return (
    <Modal title="CDI atual" subtitle="Usado para estimar todas as caixinhas que rendem % do CDI." onClose={onClose} footer={footer(onClose, save, busy)}>
      <div className="app-form">
        <Field label="CDI ao ano" htmlFor="cdi-annual" error={f.cdiAnnualPpm} hint={settings.cdiUpdatedOn ? `Última atualização em ${dateBR(settings.cdiUpdatedOn)}.` : 'Consulte o valor no app do seu banco.'}>
          <span className="ff-money">
            <input id="cdi-annual" className="ff-input" inputMode="decimal" autoComplete="off" placeholder="14,9" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
            <span aria-hidden="true">% a.a.</span>
          </span>
        </Field>
        {fallback(err, f)}
      </div>
    </Modal>
  );
}

// ---------- Detalhes

const MOVE_LABEL: Record<InvestmentMovementRow['kind'], string> = { initial: 'Valor inicial', deposit: 'Aporte', withdrawal: 'Resgate' };
const pctPermil = (permil: number) => `${(permil / 10).toFixed(1).replace('.0', '').replace('.', ',')}%`;

export function InvestmentDetailModal({ walletId, id, onClose }: { walletId: string; id: string; onClose: () => void }) {
  const toast = useToast();
  const q = useInvestment(walletId, id);
  const [editing, setEditing] = useState<InvestmentMovementRow | null>(null);
  const [removing, setRemoving] = useState<InvestmentMovementRow | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const d = q.data;

  async function removeAnchor(anchorId: string) {
    setErr(null);
    try {
      await api.del(`${walletUrl(walletId)}/investments/${id}/anchors/${anchorId}`);
      invalidateInvestments(walletId);
      toast('Saldo removido.');
    } catch (e) {
      setErr(e);
    }
  }

  return (
    <Modal wide title={d?.name ?? 'Caixinha'} subtitle={d ? `${INVESTMENT_KIND_LABELS[d.kind]} · ${formatYield(d)}` : undefined} onClose={onClose}>
      {!d ? (
        <Loading />
      ) : (
        <div className="app-form">
          <dl className="app-kv">
            <dt>Saldo bruto</dt>
            <dd>{brl(d.grossCents)}</dd>
            <dt>Aportado</dt>
            <dd>{brl(d.principalCents)}</dd>
            <dt>Rendeu até hoje</dt>
            <dd>
              {d.yieldCents < 0 ? '− ' : ''}
              {brl(Math.abs(d.yieldCents))}
            </dd>
            <dt>Imposto se resgatar hoje</dt>
            <dd>{brl(d.taxTodayCents)}</dd>
            <dt>Líquido hoje</dt>
            <dd>{brl(d.netTodayCents)}</dd>
            <dt>Imposto</dt>
            <dd>{TAX_MODE_LABELS[d.taxMode]}</dd>
            {d.goalCents && (
              <>
                <dt>Meta</dt>
                <dd>
                  {brl(d.goalCents)} · {goalText(d)}
                </dd>
              </>
            )}
            {d.redeemableFrom && (
              <>
                <dt>Resgate a partir de</dt>
                <dd>{dateBR(d.redeemableFrom)}</dd>
              </>
            )}
            {d.closedOn && (
              <>
                <dt>Encerrada em</dt>
                <dd>{dateBR(d.closedOn)}</dd>
              </>
            )}
          </dl>

          {d.taxByBracket.length > 0 && (
            <section aria-labelledby="idm-tax">
              <h3 id="idm-tax" className="app-section-title">
                Imposto se resgatar hoje
              </h3>
              <div className="ff-table-wrap">
                <table className="ff-table app-whatif">
                  <caption className="app-sr">Imposto por faixa de prazo</caption>
                  <thead>
                    <tr>
                      <th scope="col">Prazo do aporte</th>
                      <th scope="col" className="is-num">
                        Rendimento
                      </th>
                      <th scope="col" className="is-num">
                        Alíquota
                      </th>
                      <th scope="col" className="is-num">
                        Imposto
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.taxByBracket.map((r) => (
                      <tr key={r.label}>
                        <th scope="row">{r.label}</th>
                        <td className="is-num">{brl(r.yieldCents)}</td>
                        <td className="is-num">
                          IR {pctPermil(r.irRatePermil)}
                          {r.iofCents > 0 ? ' + IOF' : ''}
                        </td>
                        <td className="is-num">{brl(r.irCents + r.iofCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section aria-labelledby="idm-moves">
            <h3 id="idm-moves" className="app-section-title">
              Movimentações
            </h3>
            <ul className="app-plain-list">
              {d.movements.map((m) => (
                <li key={m.id} className="app-plain-list__row">
                  <span>
                    <strong className="ff-num">{brl(m.amountCents)}</strong> em {dateBR(m.date)} · {MOVE_LABEL[m.kind]}
                    {m.kind === 'withdrawal' && m.taxCents ? ` (impostos de ${brl(m.taxCents)})` : ''}
                    {m.beforeAnchor && d.anchor && <small className="app-block ff-muted">Já considerado no saldo de {dateBR(d.anchor.date, true)}</small>}
                  </span>
                  <span className="app-actions-row">
                    <IconButton icon="pencil" label={`Editar ${MOVE_LABEL[m.kind].toLowerCase()} de ${dateBR(m.date)}`} onClick={() => setEditing(m)} />
                    {m.kind !== 'initial' && <IconButton icon="trash" label={`Excluir ${MOVE_LABEL[m.kind].toLowerCase()} de ${dateBR(m.date)}`} onClick={() => setRemoving(m)} />}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          {d.anchors.length > 0 && (
            <section aria-labelledby="idm-anchors">
              <h3 id="idm-anchors" className="app-section-title">
                Saldos informados
              </h3>
              <ul className="app-plain-list">
                {d.anchors.map((a, i) => (
                  <li key={a.id} className="app-plain-list__row">
                    <span>
                      <strong className="ff-num">{brl(a.balanceCents)}</strong> em {dateBR(a.date)}
                      {i === 0 && <small className="app-block ff-muted">Saldo vigente</small>}
                    </span>
                    <IconButton icon="trash" label={`Remover o saldo de ${dateBR(a.date)}`} onClick={() => removeAnchor(a.id)} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {err ? <Notice tone="danger">{errorText(err)}</Notice> : null}
        </div>
      )}
      {editing && d && <MovementEditModal walletId={walletId} investmentId={d.id} mov={editing} onClose={() => setEditing(null)} />}
      {removing && (
        <RemoveMovementDialog walletId={walletId} investmentId={id} mov={removing} onClose={() => setRemoving(null)} />
      )}
    </Modal>
  );
}

function MovementEditModal({ walletId, investmentId, mov, onClose }: { walletId: string; investmentId: string; mov: InvestmentMovementRow; onClose: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState(mov.date);
  const [amount, setAmount] = useState<number | null>(mov.amountCents);
  const [tax, setTax] = useState<number | null>(mov.taxCents);
  const { busy, err, setErr, run } = useSubmit(() => {
    invalidateInvestments(walletId);
    toast('Movimentação atualizada.');
    onClose();
  });
  const save = () => {
    if (!amount) return setErr(new Error('Informe o valor.'));
    void run(() =>
      api.put(`${walletUrl(walletId)}/investments/${investmentId}/movements/${mov.id}`, {
        date,
        amountCents: amount,
        taxCents: mov.kind === 'withdrawal' ? (tax ?? 0) : null,
        version: mov.version,
      }),
    );
  };
  const f = fieldErrors(err);
  return (
    <Modal title={`Editar ${MOVE_LABEL[mov.kind].toLowerCase()}`} onClose={onClose} footer={footer(onClose, save, busy)}>
      <div className="app-form">
        <div className="app-grid2">
          <Field label="Valor" htmlFor="me-amount" error={f.amountCents}>
            <MoneyInput id="me-amount" value={amount} onChange={setAmount} autoFocus />
          </Field>
          <Field label="Data" htmlFor="me-date" error={f.date}>
            <input id="me-date" type="date" className="ff-input ff-num" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        {mov.kind === 'withdrawal' && (
          <Field label="Impostos retidos" htmlFor="me-tax" error={f.taxCents}>
            <MoneyInput id="me-tax" value={tax} onChange={setTax} />
          </Field>
        )}
        {fallback(err, f)}
      </div>
    </Modal>
  );
}

function RemoveMovementDialog({ walletId, investmentId, mov, onClose }: { walletId: string; investmentId: string; mov: InvestmentMovementRow; onClose: () => void }) {
  const toast = useToast();
  const { busy, err, run } = useSubmit(() => {
    invalidateInvestments(walletId);
    toast('Movimentação excluída.');
    onClose();
  });
  return (
    <ConfirmDialog
      title={`Excluir ${MOVE_LABEL[mov.kind].toLowerCase()}?`}
      message={`${brl(mov.amountCents)} em ${dateBR(mov.date)}. O saldo estimado e o balanço do mês serão recalculados.`}
      confirmLabel="Excluir"
      busy={busy}
      error={err ? errorText(err) : undefined}
      onClose={onClose}
      onConfirm={() => void run(() => api.del(`${walletUrl(walletId)}/investments/${investmentId}/movements/${mov.id}`))}
    />
  );
}
