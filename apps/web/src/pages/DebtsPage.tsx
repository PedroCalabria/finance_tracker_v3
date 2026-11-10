import { useState } from 'react';
import { DEBT_STRATEGY_LABELS, formatMonthShort, type DebtPlan, type DebtRow, type DebtStrategy } from '@ff/shared';
import { Icon, type IconName } from '../components/Icon';
import { Button, ConfirmDialog, EmptyState, Loading, Notice, Segmented, brl, dateBR, errorText, useToast } from '../components/ui';
import { DebtFormModal } from '../debts/DebtFormModal';
import { DebtList, type DebtAction } from '../debts/DebtList';
import { BalanceAnchorModal, BudgetModal, DebtDetailModal, PayOffModal, WhatIfModal } from '../debts/DebtModals';
import { DebtPaymentModal, type PaymentPreset } from '../debts/DebtPaymentModal';
import { DebtTimeline, StrategyCompare } from '../debts/DebtTimeline';
import { monthLabel, signedBRL } from '../debts/format';
import { api } from '../lib/api';
import { useIsMobile } from '../lib/hooks';
import { invalidateDebts, useDebtPlan, useDebts, usePeople, walletUrl } from '../lib/queries';

type Dialog =
  | { kind: 'create' }
  | { kind: 'budget' }
  | { kind: 'pay'; debt: DebtRow; preset?: PaymentPreset }
  | { kind: Exclude<DebtAction, 'pay'>; debt: DebtRow }
  | null;

/**
 * Tela "Dívidas" (ADR-0011): resumo, orçamento (planejado × destinado), lista na ordem da estratégia,
 * timeline, comparação de estratégias e quitadas. Isolada da tabela do mês.
 */
export function DebtsPage({ walletId }: { walletId: string }) {
  const debts = useDebts(walletId);
  const plan = useDebtPlan(walletId);
  const people = usePeople(walletId);
  const mobile = useIsMobile();
  const compact = useIsMobile('(max-width: 1023px)');
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [err, setErr] = useState<unknown>(null);
  const close = () => setDialog(null);

  if (debts.isError || plan.isError) return <div className="app-content"><Notice tone="danger">{errorText(debts.error ?? plan.error)}</Notice></div>;
  if (!debts.data || !plan.data) return <Loading />;
  const p = plan.data;
  const all = debts.data;
  const active = all.filter((d) => d.status === 'active');
  const paidOff = all.filter((d) => d.status === 'paid_off');
  const manual = p.strategy === 'manual';

  async function setStrategy(strategy: DebtStrategy) {
    setErr(null);
    try {
      await api.put(`${walletUrl(walletId)}/debt-settings`, { strategy });
      invalidateDebts(walletId);
    } catch (e) {
      setErr(e);
    }
  }
  async function move(id: string, delta: -1 | 1) {
    const ids = [...p.order];
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    setErr(null);
    try {
      await api.put(`${walletUrl(walletId)}/debts/order`, { ids });
      invalidateDebts(walletId);
    } catch (e) {
      setErr(e);
    }
  }
  async function reopen(d: DebtRow) {
    try {
      await api.post(`${walletUrl(walletId)}/debts/${d.id}/reopen`);
      invalidateDebts(walletId);
      toast(manual ? 'Dívida reaberta. Ela entrou no fim da sua ordem.' : 'Dívida reaberta.');
    } catch (e) {
      setErr(e);
    }
  }

  const header = (
    <div className="app-pagehead">
      <div>
        <p className="ff-caption app-m0">Planejamento</p>
        <h1 className="app-pagehead__title">Dívidas</h1>
      </div>
      <div className="app-actions-row">
        <Button onClick={() => setDialog({ kind: 'budget' })}>{p.totals.budgetCents === null ? 'Definir orçamento' : 'Alterar orçamento'}</Button>
        {!mobile && (
          <Button variant="primary" icon="plus" onClick={() => setDialog({ kind: 'create' })}>
            Nova dívida
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <div className="app-content">
      {header}
      {err ? <Notice tone="danger">{errorText(err)}</Notice> : null}

      {all.length === 0 ? (
        <EmptyState
          title="Organize a quitação das suas dívidas"
          action={
            <div className="app-actions-row">
              <Button variant="primary" icon="plus" onClick={() => setDialog({ kind: 'create' })}>
                Nova dívida
              </Button>
              <Button onClick={() => setDialog({ kind: 'budget' })}>Definir orçamento</Button>
            </div>
          }
        >
          Cadastre cada dívida com o saldo e a taxa, diga quanto consegue destinar por mês, e o app mostra quando cada uma termina, quanto de juros você paga e qual pagar primeiro.
        </EmptyState>
      ) : (
        <>
          <Summary plan={p} activeCount={active.length} onBudget={() => setDialog({ kind: 'budget' })} />
          <Warnings plan={p} onBudget={() => setDialog({ kind: 'budget' })} />

          <section className="app-form" aria-labelledby="debts-list">
            <div className="app-toolbar">
              <h2 id="debts-list" className="app-section-title">
                Suas dívidas
              </h2>
              <Segmented
                label="Estratégia de prioridade"
                value={p.strategy}
                onChange={setStrategy}
                options={(['avalanche', 'snowball', 'manual'] as const).map((s) => ({ value: s, label: DEBT_STRATEGY_LABELS[s] }))}
              />
            </div>
            <p className="ff-caption app-m0">{strategyHint(p.strategy)}</p>
            {active.length === 0 ? (
              <EmptyState title="Nenhuma dívida ativa">Todas as dívidas cadastradas estão quitadas.</EmptyState>
            ) : (
              <DebtList debts={active} plan={p} manual={manual} onMove={move} onAction={(kind, debt) => setDialog({ kind, debt })} />
            )}
          </section>

          {p.perDebt.length > 0 && (
            <section className="ff-card app-card-pad" aria-labelledby="debts-timeline">
              <h2 id="debts-timeline" className="app-section-title">
                Linha do tempo
              </h2>
              <p className="ff-caption app-m0">Saldo de cada dívida até a quitação, seguindo a estratégia escolhida e o orçamento.</p>
              <DebtTimeline plan={p} debts={active} />
            </section>
          )}

          {p.perDebt.length > 0 && (
            <section className="app-form" aria-labelledby="debts-compare">
              <h2 id="debts-compare" className="app-section-title">
                Comparação de estratégias
              </h2>
              <StrategyCompare plan={p} compact={compact} />
            </section>
          )}

          <BudgetSection plan={p} compact={compact} />

          {paidOff.length > 0 && (
            <details className="ff-card app-card-pad app-paidoff">
              <summary className="app-section-title">Quitadas ({paidOff.length})</summary>
              <ul className="app-plain-list">
                {paidOff.map((d) => (
                  <li key={d.id} className="app-plain-list__row">
                    <span>
                      <strong>{d.name}</strong>
                      <small className="app-block ff-muted">
                        Quitada em {dateBR(d.paidOffOn)} · total pago {brl(d.paidCents)}
                      </small>
                    </span>
                    <span className="app-actions-row">
                      <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'details', debt: d })}>
                        Histórico
                      </Button>
                      <Button size="sm" onClick={() => reopen(d)}>
                        Reabrir
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      {mobile && (
        <Button variant="primary" className="ff-fab" aria-label="Nova dívida" onClick={() => setDialog({ kind: 'create' })}>
          <Icon name="plus" />
        </Button>
      )}

      {dialog?.kind === 'create' && <DebtFormModal walletId={walletId} people={people.data ?? []} manualOrder={manual} onClose={close} />}
      {dialog?.kind === 'edit' && <DebtFormModal walletId={walletId} debt={dialog.debt} people={people.data ?? []} manualOrder={manual} onClose={close} />}
      {dialog?.kind === 'budget' && <BudgetModal walletId={walletId} currentMonth={p.currentMonth} onClose={close} />}
      {dialog?.kind === 'pay' && <DebtPaymentModal walletId={walletId} debt={dialog.debt} preset={dialog.preset} onClose={close} />}
      {dialog?.kind === 'anchor' && <BalanceAnchorModal walletId={walletId} debt={dialog.debt} onClose={close} />}
      {dialog?.kind === 'whatif' && <WhatIfModal debt={dialog.debt} onClose={close} onRegister={(preset) => setDialog({ kind: 'pay', debt: dialog.debt, preset })} />}
      {dialog?.kind === 'payoff' && <PayOffModal walletId={walletId} debt={dialog.debt} onClose={close} />}
      {dialog?.kind === 'details' && <DebtDetailModal walletId={walletId} debtId={dialog.debt.id} onClose={close} />}
      {dialog?.kind === 'delete' && <DeleteDebtDialog walletId={walletId} debt={dialog.debt} onClose={close} />}
    </div>
  );
}

function strategyHint(s: DebtStrategy): string {
  if (s === 'avalanche') return 'Avalanche: a sobra do orçamento vai primeiro para a dívida de maior taxa. É a que paga menos juros.';
  if (s === 'snowball') return 'Bola de neve: a sobra vai primeiro para a dívida de menor saldo. As primeiras quitações chegam mais cedo.';
  return 'Minha ordem: a sobra segue a ordem que você escolher com as setas.';
}

function Summary({ plan, activeCount, onBudget }: { plan: DebtPlan; activeCount: number; onBudget: () => void }) {
  const t = plan.totals;
  const cards: Array<{ icon: IconName; title: string; subtitle: string; value: string; hero?: boolean; action?: React.ReactNode }> = [
    { icon: 'wallet', title: 'Total devedor', subtitle: `${activeCount} ${activeCount === 1 ? 'dívida ativa' : 'dívidas ativas'}`, value: brl(t.balanceCents), hero: true },
    { icon: 'calendar', title: 'Quitação de todas', subtitle: 'Previsão com o orçamento', value: t.balanceCents === 0 ? '—' : monthLabel(t.payoffMonth) },
    { icon: 'trend', title: 'Juros futuros', subtitle: 'Estimativa até quitar', value: t.payoffMonth === null && t.balanceCents > 0 ? '—' : brl(t.interestCents) },
    {
      icon: 'sliders',
      title: 'Orçamento do mês',
      subtitle: 'Para todas as dívidas',
      value: t.budgetCents === null ? 'Sem orçamento' : brl(t.budgetCents),
      action: (
        <Button size="sm" variant="ghost" onClick={onBudget}>
          Alterar
        </Button>
      ),
    },
  ];
  return (
    <div className="ff-summary-grid app-debt-summary">
      {cards.map((c) => (
        <article key={c.title} className={`ff-summary${c.hero ? ' ff-summary--hero' : ''}`} aria-label={c.title}>
          <div className="ff-summary__body">
            <div className="ff-summary__head">
              <span className="ff-summary__icon">
                <Icon name={c.icon} />
              </span>
              <div>
                <h2 className="ff-summary__title">{c.title}</h2>
                <p className="ff-summary__subtitle">{c.subtitle}</p>
              </div>
            </div>
            <p className="ff-summary__value app-debt-summary__value">{c.value}</p>
            {c.action}
          </div>
        </article>
      ))}
    </div>
  );
}

function Warnings({ plan, onBudget }: { plan: DebtPlan; onBudget: () => void }) {
  if (!plan.warnings.length) return null;
  return (
    <div className="app-form">
      {plan.warnings.map((w, i) =>
        w.code === 'no_budget' ? (
          <Notice key={i}>
            {w.message}{' '}
            <button type="button" className="app-linklike" onClick={onBudget}>
              Definir orçamento
            </button>
          </Notice>
        ) : (
          <Notice key={i} tone={w.code === 'budget_short' || w.code === 'never_paid_off' ? 'danger' : 'info'}>
            {w.message}
          </Notice>
        ),
      )}
    </div>
  );
}

function BudgetSection({ plan, compact }: { plan: DebtPlan; compact: boolean }) {
  if (!plan.budgetMonths.length) return null;
  const diff = (m: DebtPlan['budgetMonths'][number]) => (m.plannedCents === null ? null : m.spentCents - m.plannedCents);
  const monthText = (m: DebtPlan['budgetMonths'][number]) => `${formatMonthShort(m.month, true)}${m.inProgress ? ' (em andamento)' : ''}`;
  const diffCell = (m: DebtPlan['budgetMonths'][number]) => {
    const d = diff(m);
    if (d === null) return '—';
    return <span className={d < 0 && !m.inProgress ? 'app-amount-short' : undefined}>{signedBRL(d)}</span>;
  };
  return (
    <section className="app-form" aria-labelledby="debts-budget">
      <h2 id="debts-budget" className="app-section-title">
        Orçamento: planejado × destinado
      </h2>
      <p className="ff-caption app-m0">Destinado é a soma dos pagamentos de dívidas registrados no mês.</p>
      {compact ? (
        <div className="ff-list">
          {plan.budgetMonths.map((m) => (
            <div key={m.month} className="ff-occ">
              <p className="ff-occ__name">{monthText(m)}</p>
              <p className="ff-occ__amount">{diffCell(m)}</p>
              <p className="ff-occ__due">
                Planejado {m.plannedCents === null ? 'sem orçamento' : brl(m.plannedCents)} · destinado {brl(m.spentCents)}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <div className="ff-table-wrap">
          <table className="ff-table">
            <caption className="app-sr">Planejado e destinado por mês</caption>
            <thead>
              <tr>
                <th scope="col">Mês</th>
                <th scope="col" className="is-num">Planejado</th>
                <th scope="col" className="is-num">Destinado</th>
                <th scope="col" className="is-num">Diferença</th>
              </tr>
            </thead>
            <tbody>
              {plan.budgetMonths.map((m) => (
                <tr key={m.month}>
                  <th scope="row" className="is-service">
                    {monthText(m)}
                  </th>
                  <td className="is-num">{m.plannedCents === null ? 'Sem orçamento' : brl(m.plannedCents)}</td>
                  <td className="is-num">{brl(m.spentCents)}</td>
                  <td className="is-num">{diffCell(m)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DeleteDebtDialog({ walletId, debt, onClose }: { walletId: string; debt: DebtRow; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <ConfirmDialog
      title="Excluir dívida"
      message={`Excluir "${debt.name}"? Ela e os pagamentos dela somem da tela e deixam de contar no destinado. Se você terminou de pagar, prefira "Marcar como quitada".`}
      confirmLabel="Excluir"
      busy={busy}
      error={err ? errorText(err) : undefined}
      onClose={onClose}
      onConfirm={async () => {
        setBusy(true);
        try {
          await api.del(`${walletUrl(walletId)}/debts/${debt.id}`);
          invalidateDebts(walletId);
          toast('Dívida excluída.');
          onClose();
        } catch (e) {
          setErr(e);
          setBusy(false);
        }
      }}
    />
  );
}
