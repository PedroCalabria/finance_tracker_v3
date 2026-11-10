import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ItemType, Summary } from '@ff/shared';
import { Icon, type IconName } from '../components/Icon';
import { StatusBadge, brl } from '../components/ui';

const signedBRL = (c: number) => `${c < 0 ? '− ' : ''}${brl(Math.abs(c))}`;

/** O mês tem dinheiro com destino (caixinhas, resgates ou amortização extra)? Senão, o card fica como antes. */
const hasAllocations = (s: Summary) => s.investments.forecastCents > 0 || s.investments.withdrawnCents > 0 || s.debtExtra.forecastCents > 0;

/**
 * Balanço com a conta à mostra (ADR-0012): entradas − gastos − guardar em caixinhas + resgatado − amortizar
 * dívidas. As linhas com destino têm um ⓘ que abre a explicação embaixo (sem tooltip: no celular não há
 * "passar o mouse"). Linhas zeradas ficam ocultas.
 */
function BalanceCard({ s }: { s: Summary }) {
  const inv = s.investments;
  const debt = s.debtExtra;
  const past = inv.plannedCents === null;
  const lines: Array<{ key: string; label: string; cents: number; sign: '' | '−' | '+'; info?: { text: string; to: string; link: string } }> = [
    { key: 'in', label: 'Entradas', cents: s.income.forecastCents, sign: '' },
    { key: 'out', label: 'Gastos', cents: s.expense.forecastCents, sign: '−' },
    {
      key: 'inv',
      label: 'Guardar em caixinhas',
      cents: inv.forecastCents,
      sign: '−',
      info: {
        text: past
          ? `Guardado neste mês: ${brl(inv.depositedCents)}.`
          : `${brl(inv.depositedCents)} já guardados · ${brl(Math.max(0, inv.forecastCents - inv.depositedCents))} a guardar neste mês.`,
        to: '/investimentos',
        link: 'Ver investimentos',
      },
    },
    { key: 'wd', label: 'Resgatado das caixinhas', cents: inv.withdrawnCents, sign: '+' },
    {
      key: 'debt',
      label: 'Amortizar dívidas',
      cents: debt.forecastCents,
      sign: '−',
      info: {
        text: `Orçamento de dívidas menos as parcelas, que já estão nos gastos${debt.paidCents ? ` (${brl(debt.paidCents)} já amortizados)` : ''}. Não lance a amortização também na tabela do mês.`,
        to: '/dividas',
        link: 'Ver dívidas',
      },
    },
  ];
  return (
    <article className="ff-summary ff-summary--hero app-balance-card" aria-label="Balanço do mês">
      <div className="ff-summary__body">
        <div className="ff-summary__head">
          <span className="ff-summary__icon">
            <Icon name="wallet" />
          </span>
          <div>
            <h2 className="ff-summary__title">Balanço do mês</h2>
            <p className="ff-summary__subtitle">Livre no mês, depois do que tem destino</p>
          </div>
        </div>
        <p className="ff-summary__value">
          {signedBRL(s.balance.forecastCents)} <span className="app-balance__tag">livre no mês</span>
        </p>
        <dl className="app-balance">
          {lines
            .filter((l) => l.cents !== 0 || l.key === 'in' || l.key === 'out')
            .map((l) => (
              <BalanceLine key={l.key} label={l.label} cents={l.cents} sign={l.sign} info={l.info} />
            ))}
        </dl>
        <p className="ff-summary__meta">
          Na conta até agora: <strong>{signedBRL(s.balance.realizedCents)}</strong>
        </p>
      </div>
    </article>
  );
}

function BalanceLine({ label, cents, sign, info }: { label: string; cents: number; sign: '' | '−' | '+'; info?: { text: string; to: string; link: string } }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="app-balance__line">
      <dt>
        {sign && <span aria-hidden="true">{sign} </span>}
        {label}
        {info && (
          <button type="button" className="app-balance__info" aria-expanded={open} aria-controls={id} aria-label={`De onde vem: ${label}`} onClick={() => setOpen((o) => !o)}>
            <Icon name="info" />
          </button>
        )}
      </dt>
      <dd className="ff-num">
        {sign === '−' && <span className="app-sr">menos </span>}
        {sign === '+' && <span className="app-sr">mais </span>}
        {brl(cents)}
      </dd>
      {info && open && (
        <p id={id} className="app-balance__explain">
          {info.text} <Link to={info.to}>{info.link}</Link>
        </p>
      )}
    </div>
  );
}

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
      {s && hasAllocations(s) ? (
        <BalanceCard s={s} />
      ) : (
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
      )}
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
