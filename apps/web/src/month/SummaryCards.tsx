import type { ItemType, Summary } from '@ff/shared';
import { Icon, type IconName } from '../components/Icon';
import { StatusBadge, brl } from '../components/ui';

/**
 * Os três cards do mês (design system: SummaryCard). O previsto do mês fica em destaque
 * e o realizado na linha de baixo (ADR-0004). Gastos = consumo pelo mês do gasto (no
 * crédito, o mês da compra); "Na conta até agora" = caixa (recebido − o que saiu da conta,
 * inclusive faturas pagas). Só o Balanço é preenchido.
 */
export function SummaryCards({ summary, onSeeType }: { summary: Summary | undefined; onSeeType: (t: ItemType) => void }) {
  const s = summary;
  const value = (c: number | undefined) => (c === undefined ? '—' : brl(c));
  const signed = (c: number) => `${c < 0 ? '− ' : ''}${brl(Math.abs(c))}`;
  return (
    <div className="ff-summary-grid">
      <Card
        hero
        icon="wallet"
        title="Balanço do mês"
        subtitle="Entradas menos gastos do mês"
        value={s && signed(s.balance.forecastCents)}
        meta={
          <>
            Na conta até agora: <strong>{s ? signed(s.balance.realizedCents) : '—'}</strong>
          </>
        }
      />
      <Card
        icon="in"
        title="Entradas do mês"
        subtitle="Previsto no mês"
        value={value(s?.income.forecastCents)}
        meta={
          <>
            <span>
              <strong>{value(s?.income.receivedCents)}</strong> recebido
            </span>
            <span aria-hidden="true">·</span>
            <span>
              <strong>{value(s?.income.pendingCents)}</strong> a receber
            </span>
          </>
        }
        footLabel="Ver entradas"
        onFoot={() => onSeeType('income')}
      />
      <Card
        icon="out"
        title="Gastos do mês"
        subtitle="Previsto no mês"
        value={value(s?.expense.forecastCents)}
        meta={
          <>
            <span>
              <strong>{value(s?.expense.paidCents)}</strong> pago
            </span>
            <span aria-hidden="true">·</span>
            <span>
              <strong>{value(s?.expense.pendingCents)}</strong> a pagar
            </span>
            {s && s.expense.lateCents > 0 && <StatusBadge status="late" label={`${brl(s.expense.lateCents)} em atraso`} />}
          </>
        }
        footLabel="Ver despesas"
        onFoot={() => onSeeType('expense')}
      />
    </div>
  );
}

function Card({
  hero,
  icon,
  title,
  subtitle,
  value,
  meta,
  footLabel,
  onFoot,
}: {
  hero?: boolean;
  icon: IconName;
  title: string;
  subtitle: string;
  value: string | undefined;
  meta: React.ReactNode;
  footLabel?: string;
  onFoot?: () => void;
}) {
  return (
    <article className={`ff-summary${hero ? ' ff-summary--hero' : ''}`} aria-label={title}>
      <div className="ff-summary__body">
        <div className="ff-summary__head">
          <span className="ff-summary__icon">
            <Icon name={icon} />
          </span>
          <div>
            <h2 className="ff-summary__title">{title}</h2>
            <p className="ff-summary__subtitle">{subtitle}</p>
          </div>
        </div>
        <p className="ff-summary__value">{value ?? '—'}</p>
        <p className="ff-summary__meta">{meta}</p>
      </div>
      {footLabel && (
        <button type="button" className="ff-summary__foot" style={{ background: 'transparent', border: 0, borderTop: '1px solid var(--border)', cursor: 'pointer', font: 'inherit', fontWeight: 600, textAlign: 'left' }} onClick={onFoot}>
          {footLabel} <Icon name="arrow" />
        </button>
      )}
    </article>
  );
}
