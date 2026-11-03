import type { ItemType, Summary } from '@ff/shared';
import { Icon, type IconName } from '../components/Icon';
import { StatusBadge, brl } from '../components/ui';

/** Os três cards do mês (design system: SummaryCard). Só o Balanço é preenchido. */
export function SummaryCards({ summary, onSeeType }: { summary: Summary | undefined; onSeeType: (t: ItemType) => void }) {
  const s = summary;
  const value = (c: number | undefined) => (c === undefined ? '—' : brl(c));
  return (
    <div className="ff-summary-grid">
      <Card
        hero
        icon="wallet"
        title="Balanço do mês"
        subtitle="Recebido menos pago"
        value={s && `${s.balance.realizedCents < 0 ? '− ' : ''}${brl(Math.abs(s.balance.realizedCents))}`}
        meta={
          <>
            Previsto até o fim do mês: <strong>{s ? `${s.balance.forecastCents < 0 ? '− ' : ''}${brl(Math.abs(s.balance.forecastCents))}` : '—'}</strong>
          </>
        }
      />
      <Card
        icon="in"
        title="Entradas do mês"
        subtitle="O que já foi recebido"
        value={value(s?.income.receivedCents)}
        meta={
          <>
            <strong>{value(s?.income.pendingCents)}</strong> a receber
          </>
        }
        footLabel="Ver entradas"
        onFoot={() => onSeeType('income')}
      />
      <Card
        icon="out"
        title="Gastos do mês"
        subtitle="O que já foi pago"
        value={value(s?.expense.paidCents)}
        meta={
          <>
            <strong>{value(s?.expense.pendingCents)}</strong> a pagar
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
