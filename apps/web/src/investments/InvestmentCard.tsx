import { useRef } from 'react';
import { INVESTMENT_KIND_LABELS, formatYield, type InvestmentRow } from '@ff/shared';
import { Icon } from '../components/Icon';
import { Button, brl, dateBR } from '../components/ui';
import { goalPct, goalText } from './format';

export type InvestmentAction = 'deposit' | 'withdraw' | 'anchor' | 'details' | 'edit' | 'close' | 'delete' | 'stopPlan';

/**
 * Card de uma caixinha ativa (ADR-0012): ícone, nome, saldo, como rende, meta com progresso e previsão,
 * trava de resgate, Guardar/Resgatar e um menu com as demais ações.
 */
export function InvestmentCard({ inv, onAction }: { inv: InvestmentRow; onAction: (a: InvestmentAction, inv: InvestmentRow) => void }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const pct = goalPct(inv);
  const reached = !!inv.goal?.reachedNow;
  const warn = !!inv.goal && !reached && (!!inv.goal.shortfall || !inv.goal.reachedMonth);
  const act = (a: InvestmentAction) => {
    if (menu.current) menu.current.open = false;
    onAction(a, inv);
  };
  return (
    <li className="ff-card app-inv">
      <div className="app-inv__head">
        <span className="app-inv__icon">
          <Icon name={inv.icon} />
        </span>
        <div className="app-inv__title">
          <p className="ff-caption app-m0">{INVESTMENT_KIND_LABELS[inv.kind]}</p>
          <h3 className="app-inv__name">
            <button type="button" className="app-linklike" onClick={() => onAction('details', inv)}>
              {inv.name}
            </button>
          </h3>
        </div>
        <details ref={menu} className="app-menu">
          <summary className="ff-icon-btn" aria-label={`Mais ações de ${inv.name}`} title="Mais ações">
            <Icon name="more" />
          </summary>
          <div className="app-menu__list" role="group" aria-label={`Ações de ${inv.name}`}>
            <button type="button" onClick={() => act('anchor')}>
              Atualizar saldo
            </button>
            <button type="button" onClick={() => act('details')}>
              Detalhes
            </button>
            <button type="button" onClick={() => act('edit')}>
              Editar
            </button>
            <button type="button" onClick={() => act('close')} disabled={inv.locked}>
              Encerrar
            </button>
            <button type="button" onClick={() => act('delete')}>
              Excluir
            </button>
          </div>
        </details>
      </div>

      <div className="app-inv__balance">
        <p className="app-inv__amount ff-num">{brl(inv.grossCents)}</p>
        <p className="ff-caption app-m0">
          {formatYield(inv)}
          {inv.yieldCents !== 0 && ` · rendeu ${inv.yieldCents < 0 ? '− ' : ''}${brl(Math.abs(inv.yieldCents))}`}
          {inv.anchor && ` · saldo informado em ${dateBR(inv.anchor.date, true)}`}
        </p>
      </div>

      {inv.goalCents ? (
        <div className="app-inv__goal">
          <div className="app-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`Meta de ${inv.name}`}>
            <span className="app-progress__bar" style={{ width: `${pct}%` }} />
          </div>
          <p className="ff-caption app-m0">
            {pct}% de {brl(inv.goalCents)}
          </p>
          <p className={`app-inv__goaltext${warn ? ' is-warn' : ''}`}>
            {reached && <Icon name="check" />}
            {warn && <Icon name="alert" />}
            {goalText(inv)}
          </p>
          {reached && inv.monthlyPlanCents ? (
            <Button size="sm" variant="ghost" onClick={() => onAction('stopPlan', inv)}>
              Parar de guardar
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="ff-caption app-m0">Sem meta</p>
      )}

      <dl className="app-inv__facts">
        <div>
          <dt>Líquido hoje</dt>
          <dd>{brl(inv.netTodayCents)}</dd>
        </div>
        <div>
          <dt>Guardar por mês</dt>
          <dd>{inv.monthlyPlanCents ? brl(inv.monthlyPlanCents) : '—'}</dd>
        </div>
        {inv.monthlyYieldCents > 0 && (
          <div>
            <dt>Rende por mês</dt>
            <dd>cerca de {brl(inv.monthlyYieldCents)}</dd>
          </div>
        )}
        {inv.atRedeem && (
          <div>
            <dt>Em {dateBR(inv.atRedeem.date)}</dt>
            <dd>{brl(inv.atRedeem.netCents)} líquidos</dd>
          </div>
        )}
      </dl>

      {inv.locked && inv.redeemableFrom && (
        <p className="ff-badge ff-badge--neutral app-inv__lock">
          <Icon name="clock" />
          Resgate a partir de {dateBR(inv.redeemableFrom)}
        </p>
      )}

      <div className="app-actions-row">
        <Button size="sm" variant="primary" icon="plus" onClick={() => onAction('deposit', inv)} aria-label={`Guardar em ${inv.name}`}>
          Guardar
        </Button>
        {!inv.locked && inv.grossCents > 0 && (
          <Button size="sm" onClick={() => onAction('withdraw', inv)} aria-label={`Resgatar de ${inv.name}`}>
            Resgatar
          </Button>
        )}
      </div>
    </li>
  );
}
