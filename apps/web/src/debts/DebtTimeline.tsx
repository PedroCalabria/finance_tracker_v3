import { DEBT_STRATEGY_LABELS, addMonths, diffMonths, formatMonthShort, type DebtPlan, type DebtRow, type DebtStrategy, type StrategySummary } from '@ff/shared';
import { brl } from '../components/ui';
import { monthLabel } from './format';

/**
 * Timeline da estratégia escolhida (ADR-0011): uma faixa por dívida, com rótulo direto, a área do
 * saldo diminuindo até a quitação e a marca do mês em que termina. Sem paleta categórica: nenhuma
 * cor distingue dívidas. SVG próprio; o texto fica em HTML para não distorcer.
 */
export function DebtTimeline({ plan, debts }: { plan: DebtPlan; debts: DebtRow[] }) {
  const byId = new Map(debts.map((d) => [d.id, d]));
  const rows = plan.order
    .map((id) => {
      const d = byId.get(id);
      const p = plan.perDebt.find((x) => x.id === id);
      if (!d || !p) return null;
      return { d, p, points: [d.balanceCents, ...p.timeline] };
    })
    .filter((r): r is NonNullable<typeof r> => !!r);
  if (!rows.length) return null;

  const horizon = Math.max(2, ...rows.map((r) => r.points.length));
  const x = (i: number) => (i / (horizon - 1)) * 100;
  const months = horizon - 1;
  const ticks: Array<{ i: number; label: string }> = [];
  if (months <= 24) {
    const step = months > 12 ? 3 : 1;
    for (let k = 0; k < months; k += step) ticks.push({ i: k + 1, label: formatMonthShort(addMonths(plan.currentMonth, k), k === 0 || addMonths(plan.currentMonth, k).endsWith('-01')) });
  } else {
    const years = months / 12;
    const every = years > 20 ? 10 : years > 8 ? 2 : 1;
    for (let k = 0; k < months; k++) {
      const m = addMonths(plan.currentMonth, k);
      if (m.endsWith('-01') && Number(m.slice(0, 4)) % every === 0) ticks.push({ i: k + 1, label: m.slice(0, 4) });
    }
  }

  return (
    <div className="app-timeline">
      {rows.map(({ d, p, points }) => {
        const top = Math.max(1, ...points);
        const end = p.payoffMonth ? diffMonths(plan.currentMonth, p.payoffMonth) + 1 : points.length - 1;
        const shown = points.slice(0, end + 1);
        const y = (v: number) => 100 - (v / top) * 88;
        const path = `M0,100 ${shown.map((v, i) => `L${x(i).toFixed(3)},${y(v).toFixed(2)}`).join(' ')} L${x(shown.length - 1).toFixed(3)},100 Z`;
        const label = p.payoffMonth ? `quita em ${monthLabel(p.payoffMonth)}` : 'não quita com este orçamento';
        return (
          <div key={d.id} className="app-timeline__row">
            <p className="app-timeline__name">{d.name}</p>
            <div className="app-timeline__track">
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`Saldo de ${d.name}: de ${brl(d.balanceCents)} hoje, ${label}`}>
                <path className="app-timeline__area" d={path} vectorEffect="non-scaling-stroke" />
              </svg>
              {p.payoffMonth && (
                <span className="app-timeline__end" style={{ left: `${x(end)}%` }} aria-hidden="true">
                  <span className="app-timeline__dot" />
                  {/* Perto das bordas, o rótulo cresce para dentro do gráfico em vez de ser cortado. */}
                  <span className={`app-timeline__label${x(end) < 12 ? ' app-timeline__label--start' : x(end) > 88 ? ' app-timeline__label--end' : ''}`}>
                    {formatMonthShort(p.payoffMonth, true)}
                  </span>
                </span>
              )}
            </div>
          </div>
        );
      })}
      <div className="app-timeline__row app-timeline__axisrow" aria-hidden="true">
        <span />
        <div className="app-timeline__axis">
          {ticks.map((t) => (
            <span key={t.i} className={x(t.i) > 92 ? 'is-end' : undefined} style={{ left: `${x(t.i)}%` }}>
              {t.label}
            </span>
          ))}
        </div>
      </div>
      <ul className="app-timeline__text">
        {rows.map(({ d, p }) => (
          <li key={d.id}>
            <strong>{d.name}</strong>: {p.payoffMonth ? `quita em ${monthLabel(p.payoffMonth)}` : 'não quita com este orçamento'}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Frase da diferença quando a estratégia escolhida não é a de menor juros (ADR-0011). */
export function strategyDifference(plan: DebtPlan): string | null {
  const ranked = plan.comparison.filter((c) => c.strategy !== 'minimum' && c.payoffMonth !== null);
  const chosen = plan.comparison.find((c) => c.strategy === plan.strategy);
  if (!chosen || chosen.payoffMonth === null || !ranked.length) return null;
  const best = ranked.reduce((a, b) => (b.totalInterestCents < a.totalInterestCents ? b : a));
  const extra = chosen.totalInterestCents - best.totalInterestCents;
  if (best.strategy === chosen.strategy || extra <= 0) return null;
  const who = plan.strategy === 'manual' ? 'Sua ordem' : `A ${DEBT_STRATEGY_LABELS[plan.strategy].toLowerCase()}`;
  const later = diffMonths(best.payoffMonth!, chosen.payoffMonth);
  const other = DEBT_STRATEGY_LABELS[best.strategy as DebtStrategy].toLowerCase();
  return later > 0
    ? `${who} custa ${brl(extra)} a mais em juros e quita ${later === 1 ? '1 mês' : `${later} meses`} depois da ${other}.`
    : `${who} custa ${brl(extra)} a mais em juros que a ${other}.`;
}

export function StrategyCompare({ plan, compact }: { plan: DebtPlan; compact: boolean }) {
  const label = (s: StrategySummary) => DEBT_STRATEGY_LABELS[s.strategy];
  const diff = strategyDifference(plan);
  const interest = (s: StrategySummary) => (s.payoffMonth === null ? '—' : brl(s.totalInterestCents));
  return (
    <div className="app-form">
      {compact ? (
        <div className="ff-list">
          {plan.comparison.map((s) => (
            <div key={s.strategy} className="ff-occ">
              <p className="ff-occ__name">
                {label(s)} {s.strategy === plan.strategy && <span className="ff-badge ff-badge--paid">Escolhida</span>}
              </p>
              <p className="ff-occ__amount">{interest(s)}</p>
              <p className="ff-occ__due">Quitação: {monthLabel(s.payoffMonth)}</p>
            </div>
          ))}
        </div>
      ) : (
        <div className="ff-table-wrap">
          <table className="ff-table">
            <caption className="app-sr">Comparação de estratégias</caption>
            <thead>
              <tr>
                <th scope="col">Estratégia</th>
                <th scope="col">Quitação de todas</th>
                <th scope="col" className="is-num">Juros futuros</th>
              </tr>
            </thead>
            <tbody>
              {plan.comparison.map((s) => (
                <tr key={s.strategy} className={s.strategy === plan.strategy ? 'app-row-selected' : undefined}>
                  <th scope="row" className="is-service">
                    {label(s)} {s.strategy === plan.strategy && <span className="ff-badge ff-badge--paid">Escolhida</span>}
                  </th>
                  <td>{monthLabel(s.payoffMonth)}</td>
                  <td className="is-num">{interest(s)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {diff && <p className="app-m0">{diff}</p>}
    </div>
  );
}
