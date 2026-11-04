import { Fragment, useMemo, useState } from 'react';
import { METHOD_LABEL, formatMonthShort, type OccurrenceRow } from '@ff/shared';
import { Icon } from '../components/Icon';
import { Button, IconButton, Loading, StatusBadge, brl, dateBR, rowBadge } from '../components/ui';
import { api } from '../lib/api';
import { invalidateFinance, useItem, walletUrl } from '../lib/queries';

/**
 * Tabela do mês no computador (design system: OccurrenceTable). Colunas na ordem
 * da especificação; o valor vem depois de Parcela.
 */

type SortKey = 'description' | 'category' | 'value' | 'due';
const canPay = (r: OccurrenceRow) => !r.invoice && r.method !== 'credit' && !['paid', 'canceled'].includes(r.displayStatus);

function sortRows(rows: OccurrenceRow[], key: SortKey | null, dir: 1 | -1): OccurrenceRow[] {
  if (!key) return rows;
  const val = (r: OccurrenceRow): string | number =>
    key === 'description' ? r.description.toLowerCase() : key === 'category' ? (r.category?.name ?? '~').toLowerCase() : key === 'value' ? r.expectedCents : (r.dueDate ?? '9999');
  return [...rows].sort((a, b) => (val(a) < val(b) ? -dir : val(a) > val(b) ? dir : 0));
}

export function OccurrenceTable({ walletId, rows, onPay, onOpen }: { walletId: string; rows: OccurrenceRow[]; onPay: (r: OccurrenceRow) => void; onOpen: (r: OccurrenceRow) => void }) {
  const [sort, setSort] = useState<{ key: SortKey | null; dir: 1 | -1 }>({ key: null, dir: 1 });
  const [open, setOpen] = useState<string | null>(null);
  const sorted = useMemo(() => sortRows(rows, sort.key, sort.dir), [rows, sort]);
  const th = (label: string, key?: SortKey, num?: boolean) => (
    <th className={num ? 'is-num' : undefined} aria-sort={key && sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
      {key ? (
        <button type="button" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}>
          {label}
          <Icon name="updown" />
        </button>
      ) : (
        label
      )}
    </th>
  );
  return (
    <div className="ff-table-wrap app-occ-table">
      <table className="ff-table">
        <thead>
          <tr>
            <th className="app-col-toggle">
              <span className="app-sr">Expandir</span>
            </th>
            {th('Serviço', 'description')}
            {th('Categoria', 'category')}
            {th('Parcela')}
            {th('Valor', 'value', true)}
            {th(rows[0]?.type === 'income' ? 'Data p/ recebimento' : 'Data p/ pagamento', 'due')}
            <th className="app-col-method">Método</th>
            <th>Banco</th>
            {th(rows[0]?.type === 'income' ? 'Data do recebimento' : 'Data do pagamento')}
            <th className="app-col-note">Observação</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const expandable = r.form !== 'single' && !r.projected;
            const isOpen = open === r.id;
            const badge = rowBadge(r);
            // O selo fica junto do nome; a coluna de pagamento mostra só a ação ou a data.
            const showBadge = !r.invoice && r.method !== 'credit' && r.displayStatus !== 'paid';
            const paidDiffers = r.paidCents > 0 && r.paidCents !== r.expectedCents && r.displayStatus === 'paid';
            return (
              <Fragment key={r.id}>
                <tr className={r.projected ? 'is-projected' : undefined}>
                  <td className="app-col-toggle">
                    {expandable && (
                      <button
                        type="button"
                        className="ff-icon-btn ff-expand"
                        aria-expanded={isOpen}
                        aria-label={`${r.form === 'installment' ? 'Ver todas as parcelas' : 'Ver os meses'} de ${r.description}`}
                        onClick={() => setOpen(isOpen ? null : r.id)}
                      >
                        <Icon name="down" />
                      </button>
                    )}
                  </td>
                  <td className="is-service">
                    <div className="app-cell-service">
                      <button type="button" className="app-linklike" onClick={() => onOpen(r)}>
                        {r.description}
                      </button>
                      {r.projected && <span className="app-projected-tag">Previsto</span>}
                      {showBadge && <StatusBadge status={badge.status} label={badge.label} />}
                      {r.note && <span className="app-note-inline">{r.note}</span>}
                    </div>
                  </td>
                  <td className="app-wrap">{r.category?.name ?? '—'}</td>
                  <td>{r.installmentLabel}</td>
                  <td className="is-num">
                    <span className="ff-value">
                      {brl(paidDiffers ? r.paidCents : r.expectedCents)}
                      {paidDiffers && <small>previsto {brl(r.expectedCents)}</small>}
                    </span>
                  </td>
                  <td className="ff-num">{dateBR(r.dueDate)}</td>
                  <td className="app-col-method">{METHOD_LABEL[r.method]}</td>
                  <td className="app-wrap">
                    {r.account?.name ?? '—'}
                    <span className="app-method-inline">{METHOD_LABEL[r.method]}</span>
                  </td>
                  <td>
                    <PaymentCell walletId={walletId} r={r} onPay={onPay} />
                  </td>
                  <td className="is-note app-col-note">{r.note ?? ''}</td>
                </tr>
                {isOpen && <Subgrid walletId={walletId} row={r} />}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PaymentCell({ walletId, r, onPay }: { walletId: string; r: OccurrenceRow; onPay: (r: OccurrenceRow) => void }) {
  const [busy, setBusy] = useState(false);
  const badge = rowBadge(r);
  if (r.invoice || r.method === 'credit') {
    return <StatusBadge status={badge.status} label={r.invoice ? `${badge.label ?? labelOfInvoice(r)} · ${formatMonthShort(r.invoice.referenceMonth)}` : 'Fatura prevista'} />;
  }
  const last = r.payments.at(-1);
  if (r.displayStatus === 'paid' && last) {
    const attachments = r.payments.flatMap((p) => p.attachments);
    return (
      <span className="app-paycell">
        <span className="ff-paid__date">
          <Icon name="check" />
          {dateBR(last.paidAt)}
        </span>
        <IconButton icon="pencil" label="Editar pagamento" onClick={() => onPay(r)} />
        <IconButton
          icon="undo"
          label={r.type === 'income' ? 'Desmarcar recebimento' : 'Desmarcar pagamento'}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await api.del(`${walletUrl(walletId)}/occurrences/${r.id}/payments`).finally(() => setBusy(false));
            invalidateFinance(walletId);
          }}
        />
        {attachments.map((a) => (
          <a key={a.id} className="app-attach" href={`${walletUrl(walletId)}/attachments/${a.id}`} target="_blank" rel="noreferrer" title={a.name}>
            <Icon name="file" />
            <span className="app-sr">Comprovante </span>
            {attachments.length > 1 ? '' : 'Comprovante'}
          </a>
        ))}
      </span>
    );
  }
  if (!canPay(r)) return <span className="ff-muted">—</span>;
  return (
    <Button size="sm" onClick={() => onPay(r)}>
      {r.type === 'income' ? 'Marcar como recebido' : 'Marcar como pago'}
    </Button>
  );
}

const labelOfInvoice = (r: OccurrenceRow) =>
  ({ invoice_open: 'Fatura em aberto', invoice_late: 'Fatura atrasada', invoice_paid: 'Fatura paga', invoice_carried: 'Fatura parcialmente paga' })[
    r.displayStatus as 'invoice_open'
  ] ?? 'Fatura';

function Subgrid({ walletId, row }: { walletId: string; row: OccurrenceRow }) {
  const item = useItem(walletId, row.itemId);
  return (
    <tr className="ff-subgrid">
      <td colSpan={10} style={{ paddingLeft: 56 }}>
        {item.isPending ? (
          <Loading />
        ) : item.data ? (
          <table>
            <caption>
              {item.data.form === 'installment'
                ? `${item.data.installments} parcelas · total ${brl(item.data.totalCents ?? 0)}`
                : `Recorrente · ${brl(item.data.amountCents ?? 0)} por mês${item.data.variableAmount ? ' (valor varia)' : ''}`}
            </caption>
            <thead>
              <tr>
                <th>{item.data.form === 'installment' ? 'Parcela' : 'Mês'}</th>
                <th>Vencimento</th>
                <th className="is-num">Valor</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {item.data.occurrences.map((o) => {
                const b = rowBadge(o);
                const paid = o.payments.at(-1);
                return (
                  <tr key={o.id}>
                    <td>{item.data!.form === 'installment' ? o.installmentLabel : formatMonthShort(o.competenceMonth, true)}</td>
                    <td className="ff-num">{dateBR(o.dueDate)}</td>
                    <td className="is-num">{brl(o.paidCents && o.displayStatus === 'paid' ? o.paidCents : o.expectedCents)}</td>
                    <td>
                      <StatusBadge status={b.status} label={o.projected ? 'Previsto' : paid && o.displayStatus === 'paid' ? `${o.type === 'income' ? 'Recebido' : 'Pago'} em ${dateBR(paid.paidAt, true)}` : b.label} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </td>
    </tr>
  );
}

/** A tabela no celular: cards com Serviço, Valor, Parcela e Data p/ pagamento (design system: OccurrenceCard). */
export function OccurrenceList({ rows, onPay, onOpen }: { rows: OccurrenceRow[]; onPay: (r: OccurrenceRow) => void; onOpen: (r: OccurrenceRow) => void }) {
  return (
    <div className="ff-list">
      {rows.map((r) => {
        const b = rowBadge(r);
        const due = r.invoice ? `Fatura ${r.account?.name ?? ''} · vence ${dateBR(r.dueDate, true)}` : r.dueDate ? `${r.late ? 'Venceu' : 'Vence'} ${dateBR(r.dueDate, true)}` : 'Sem data';
        return (
          <article key={r.id} className="ff-occ" onClick={() => onOpen(r)} style={{ cursor: 'pointer' }}>
            <p className="ff-occ__kicker">
              {[r.category?.name, r.form === 'installment' ? `Parcela ${r.installmentLabel}` : r.installmentLabel === 'Única' ? null : r.installmentLabel].filter(Boolean).join(' · ') || 'Única'}
              {r.projected ? ' · Previsto' : ''}
            </p>
            <p className="ff-occ__name">
              <button type="button" className="app-linklike" onClick={(e) => (e.stopPropagation(), onOpen(r))}>
                {r.description}
              </button>
            </p>
            <p className={`ff-occ__amount${r.type === 'income' ? ' is-in' : ''}`}>
              {r.type === 'income' ? '+ ' : ''}
              {brl(r.expectedCents)}
            </p>
            <p className="ff-occ__due">{due}</p>
            <div className="ff-occ__foot" onClick={(e) => e.stopPropagation()}>
              <StatusBadge status={b.status} label={b.label} />
              {canPay(r) && (
                <Button size="sm" onClick={() => onPay(r)}>
                  {r.type === 'income' ? 'Marcar como recebido' : 'Marcar como pago'}
                </Button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
