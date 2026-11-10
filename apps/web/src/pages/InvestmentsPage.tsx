import { useState } from 'react';
import { formatRatePpm, type InvestmentOverview, type InvestmentRow, type InvestmentSettings } from '@ff/shared';
import { Icon, type IconName } from '../components/Icon';
import { Button, EmptyState, Loading, Notice, brl, dateBR, errorText, useToast } from '../components/ui';
import { InvestmentCard, type InvestmentAction } from '../investments/InvestmentCard';
import { InvestmentChart } from '../investments/InvestmentChart';
import { InvestmentFormModal } from '../investments/InvestmentFormModal';
import { AnchorModal, CdiModal, CloseModal, DeleteInvestmentDialog, InvestmentDetailModal } from '../investments/InvestmentModals';
import { MovementModal } from '../investments/MovementModal';
import { api } from '../lib/api';
import { useIsMobile } from '../lib/hooks';
import { invalidateInvestments, useInvestmentOverview, useInvestments, useInvestmentSettings, walletUrl } from '../lib/queries';

type Dialog =
  | { kind: 'create' }
  | { kind: 'cdi' }
  | { kind: 'edit' | 'deposit' | 'withdraw' | 'anchor' | 'close' | 'delete'; inv: InvestmentRow }
  | { kind: 'details'; id: string }
  | null;

/**
 * Tela "Investimentos" (ADR-0012): caixinhas no estilo do Nubank, com resumo, evolução e projeção, cards com
 * meta e trava, e as encerradas. Isolada da tabela do mês; o balanço do mês lê o que tem destino.
 */
export function InvestmentsPage({ walletId }: { walletId: string }) {
  const list = useInvestments(walletId);
  const overview = useInvestmentOverview(walletId);
  const settings = useInvestmentSettings(walletId);
  const mobile = useIsMobile();
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [err, setErr] = useState<unknown>(null);
  const close = () => setDialog(null);

  const failed = list.error ?? overview.error ?? settings.error;
  if (failed) return <div className="app-content"><Notice tone="danger">{errorText(failed)}</Notice></div>;
  if (!list.data || !overview.data || !settings.data) return <Loading />;
  const all = list.data;
  const ov = overview.data;
  const s = settings.data;
  const active = all.filter((i) => i.status === 'active');
  const closed = all.filter((i) => i.status === 'closed');

  async function stopPlan(inv: InvestmentRow) {
    setErr(null);
    try {
      await api.put(`${walletUrl(walletId)}/investments/${inv.id}`, {
        name: inv.name,
        icon: inv.icon,
        kind: inv.kind,
        yieldKind: inv.yieldKind,
        fixedRatePpm: inv.fixedRatePpm,
        cdiShareBp: inv.cdiShareBp,
        taxMode: inv.taxMode,
        goalCents: inv.goalCents,
        goalMonth: inv.goalMonth,
        redeemableFrom: inv.redeemableFrom,
        monthlyPlanCents: null,
        version: inv.version,
      });
      invalidateInvestments(walletId);
      toast(`${inv.name}: você parou de guardar todo mês.`);
    } catch (e) {
      setErr(e);
    }
  }
  async function reopen(inv: InvestmentRow) {
    setErr(null);
    try {
      await api.post(`${walletUrl(walletId)}/investments/${inv.id}/reopen`);
      invalidateInvestments(walletId);
      toast('Caixinha reaberta.');
    } catch (e) {
      setErr(e);
    }
  }
  const onAction = (a: InvestmentAction, inv: InvestmentRow) => {
    if (a === 'stopPlan') return void stopPlan(inv);
    if (a === 'details') return setDialog({ kind: 'details', id: inv.id });
    setDialog({ kind: a, inv });
  };

  const header = (
    <div className="app-pagehead">
      <div>
        <p className="ff-caption app-m0">Planejamento</p>
        <h1 className="app-pagehead__title">Investimentos</h1>
      </div>
      <div className="app-actions-row">
        <Button onClick={() => setDialog({ kind: 'cdi' })}>{cdiLabel(s)}</Button>
        {!mobile && (
          <Button variant="primary" icon="plus" onClick={() => setDialog({ kind: 'create' })}>
            Nova caixinha
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
          title="Crie sua primeira caixinha"
          action={
            <Button variant="primary" icon="plus" onClick={() => setDialog({ kind: 'create' })}>
              Nova caixinha
            </Button>
          }
        >
          Separe o dinheiro por objetivo (reserva, viagem, carro) e veja quanto rende, o imposto e quando você chega na meta.
        </EmptyState>
      ) : (
        <>
          {ov.warnings.map((w) => (
            <Notice key={w.code}>
              {w.message}{' '}
              <button type="button" className="app-linklike" onClick={() => setDialog({ kind: 'cdi' })}>
                Informar CDI
              </button>
            </Notice>
          ))}
          <SummaryRow ov={ov} />

          {active.length > 0 && (
            <section className="ff-card app-card-pad" aria-labelledby="inv-chart">
              <h2 id="inv-chart" className="app-section-title">
                Evolução
              </h2>
              <InvestmentChart overview={ov} />
            </section>
          )}

          <section className="app-form" aria-labelledby="inv-list">
            <h2 id="inv-list" className="app-section-title">
              Suas caixinhas
            </h2>
            {active.length === 0 ? (
              <EmptyState title="Nenhuma caixinha ativa">Todas as caixinhas estão encerradas.</EmptyState>
            ) : (
              <ul className="app-invs">
                {active.map((inv) => (
                  <InvestmentCard key={inv.id} inv={inv} onAction={onAction} />
                ))}
              </ul>
            )}
          </section>

          {closed.length > 0 && (
            <details className="ff-card app-card-pad app-paidoff">
              <summary className="app-section-title">Encerradas ({closed.length})</summary>
              <ul className="app-plain-list">
                {closed.map((inv) => (
                  <li key={inv.id} className="app-plain-list__row">
                    <span>
                      <strong>{inv.name}</strong>
                      <small className="app-block ff-muted">Encerrada em {dateBR(inv.closedOn)}</small>
                    </span>
                    <span className="app-actions-row">
                      <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'details', id: inv.id })}>
                        Histórico
                      </Button>
                      <Button size="sm" onClick={() => reopen(inv)}>
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
        <Button variant="primary" className="ff-fab" aria-label="Nova caixinha" onClick={() => setDialog({ kind: 'create' })}>
          <Icon name="plus" />
        </Button>
      )}

      {dialog?.kind === 'create' && <InvestmentFormModal walletId={walletId} cdiAnnualPpm={s.cdiAnnualPpm} onClose={close} />}
      {dialog?.kind === 'edit' && <InvestmentFormModal walletId={walletId} inv={dialog.inv} cdiAnnualPpm={s.cdiAnnualPpm} onClose={close} />}
      {dialog?.kind === 'cdi' && <CdiModal walletId={walletId} settings={s} onClose={close} />}
      {dialog?.kind === 'deposit' && <MovementModal walletId={walletId} inv={dialog.inv} kind="deposit" onClose={close} />}
      {dialog?.kind === 'withdraw' && <MovementModal walletId={walletId} inv={dialog.inv} kind="withdrawal" onClose={close} />}
      {dialog?.kind === 'anchor' && <AnchorModal walletId={walletId} inv={dialog.inv} onClose={close} />}
      {dialog?.kind === 'close' && <CloseModal walletId={walletId} inv={dialog.inv} onClose={close} />}
      {dialog?.kind === 'delete' && <DeleteInvestmentDialog walletId={walletId} inv={dialog.inv} onClose={close} />}
      {dialog?.kind === 'details' && <InvestmentDetailModal walletId={walletId} id={dialog.id} onClose={close} />}
    </div>
  );
}

function cdiLabel(s: InvestmentSettings): string {
  if (s.cdiAnnualPpm === null) return 'Informar CDI';
  return `CDI: ${formatRatePpm(s.cdiAnnualPpm, 2)} a.a.${s.cdiUpdatedOn ? ` · atualizado em ${dateBR(s.cdiUpdatedOn, true)}` : ''}`;
}

function SummaryRow({ ov }: { ov: InvestmentOverview }) {
  const t = ov.totals;
  const cards: Array<{ icon: IconName; title: string; subtitle: string; value: string; hero?: boolean }> = [
    { icon: 'piggy', title: 'Total guardado', subtitle: `líquido ${brl(t.netCents)}`, value: brl(t.grossCents), hero: true },
    {
      icon: 'in',
      title: 'Rendeu até hoje',
      subtitle: `IR estimado ${brl(t.taxCents)}`,
      value: `${t.yieldCents < 0 ? '− ' : ''}${brl(Math.abs(t.yieldCents))}`,
    },
    {
      icon: 'calendar',
      title: 'Guardar por mês',
      subtitle: t.planCount ? `em ${t.planCount} ${t.planCount === 1 ? 'caixinha' : 'caixinhas'}` : 'nenhuma caixinha com plano',
      value: brl(t.monthlyPlanCents),
    },
    {
      icon: 'check',
      title: 'Este mês',
      subtitle: ov.thisMonth.plannedCents ? `de ${brl(ov.thisMonth.plannedCents)} planejados` : 'guardado neste mês',
      value: brl(ov.thisMonth.depositedCents),
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
          </div>
        </article>
      ))}
    </div>
  );
}
