import type { DebtPlan, DebtRow } from '@ff/shared';
import { Icon } from '../components/Icon';
import { Button, IconButton, brl, dateBR } from '../components/ui';
import { kicker, monthLabel, obligationLabel, progressOf, rateLabel } from './format';

export type DebtAction = 'pay' | 'anchor' | 'whatif' | 'edit' | 'payoff' | 'delete' | 'details';

/**
 * Dívidas ativas na ordem da estratégia (ADR-0011). Em "Minha ordem", ↑↓ com rótulos acessíveis;
 * a ordem é gravada a cada clique.
 */
export function DebtList({
  debts,
  plan,
  manual,
  onAction,
  onMove,
}: {
  debts: DebtRow[];
  plan: DebtPlan;
  manual: boolean;
  onAction: (a: DebtAction, d: DebtRow) => void;
  onMove: (id: string, delta: -1 | 1) => void;
}) {
  const byId = new Map(debts.map((d) => [d.id, d]));
  const ordered = plan.order.map((id) => byId.get(id)).filter((d): d is DebtRow => !!d);
  return (
    <ol className="app-debts">
      {ordered.map((d, i) => {
        const payoff = plan.perDebt.find((p) => p.id === d.id)?.payoffMonth;
        const { pct, grewCents } = progressOf(d);
        const obligation = obligationLabel(d);
        return (
          <li key={d.id} className="ff-card app-debt">
            <div className="app-debt__head">
              <span className="app-debt__rank" aria-label={`Prioridade ${i + 1}`}>
                {i + 1}
              </span>
              <div className="app-debt__title">
                <p className="ff-caption app-m0">{kicker(d)}</p>
                <h3 className="app-debt__name">
                  <button type="button" className="app-linklike" onClick={() => onAction('details', d)}>
                    {d.name}
                  </button>
                </h3>
              </div>
              <div className="app-debt__balance">
                <p className="app-debt__amount ff-num">{brl(d.balanceCents)}</p>
                <p className="ff-caption app-m0">saldo informado em {dateBR(d.anchor.date, true)}</p>
              </div>
              {manual && (
                <span className="app-debt__move">
                  {i > 0 && <IconButton icon="up" label={`Subir ${d.name}`} onClick={() => onMove(d.id, -1)} />}
                  {i < ordered.length - 1 && <IconButton icon="down" label={`Descer ${d.name}`} onClick={() => onMove(d.id, 1)} />}
                </span>
              )}
            </div>

            <div className="app-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`Progresso de ${d.name}`}>
              <span className="app-progress__bar" style={{ width: `${pct}%` }} />
            </div>
            <p className="ff-caption app-m0">
              {grewCents > 0 ? `0% · o saldo cresceu ${brl(grewCents)}` : `${pct}% de ${brl(d.initial.balanceCents)} já abatido`}
            </p>

            <dl className="app-debt__facts">
              <div>
                <dt>Taxa</dt>
                <dd>{rateLabel(d.monthlyRatePpm)}</dd>
              </div>
              {obligation && (
                <div>
                  <dt>{d.structure === 'revolving' ? 'Mínimo' : 'Contrato'}</dt>
                  <dd>
                    {obligation.replace(/^(Parcela|Mínimo) de /, '')}
                    {d.remainingInstallments != null ? ` · ${d.remainingInstallments}x restantes` : ''}
                  </dd>
                </div>
              )}
              <div>
                <dt>Pago até agora</dt>
                <dd>{brl(d.paidCents)}</dd>
              </div>
              <div>
                <dt>Previsão de quitação</dt>
                <dd>{d.balanceCents === 0 ? 'Saldo zerado' : monthLabel(payoff ?? null)}</dd>
              </div>
            </dl>

            <div className="app-debt__badges">
              {!d.acceptsExtra && (
                <span className="ff-badge ff-badge--neutral">
                  <Icon name="ban" />
                  Não aceita amortização
                </span>
              )}
              {d.balanceCents === 0 && (
                <span className="ff-badge ff-badge--paid">
                  <Icon name="check" />
                  Saldo zerado: marque como quitada
                </span>
              )}
            </div>

            <div className="app-actions-row">
              <Button size="sm" variant="primary" icon="check" onClick={() => onAction('pay', d)}>
                Registrar pagamento
              </Button>
              <Button size="sm" onClick={() => onAction('anchor', d)}>
                Atualizar saldo
              </Button>
              {d.acceptsExtra && d.balanceCents > 0 && (
                <Button size="sm" onClick={() => onAction('whatif', d)}>
                  Simular amortização
                </Button>
              )}
              <Button size="sm" variant="ghost" icon="pencil" onClick={() => onAction('edit', d)}>
                Editar
              </Button>
              <Button size="sm" variant="ghost" icon="check" onClick={() => onAction('payoff', d)}>
                Marcar como quitada
              </Button>
              <Button size="sm" variant="ghost" icon="trash" onClick={() => onAction('delete', d)}>
                Excluir
              </Button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
