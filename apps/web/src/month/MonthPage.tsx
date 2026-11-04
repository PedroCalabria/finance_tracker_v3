import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { addMonths, formatMonthLong, isMonth, type InvoiceRow, type ItemType, type OccurrenceRow } from '@ff/shared';
import { Icon } from '../components/Icon';
import { Button, EmptyState, IconButton, Loading, Notice, errorText } from '../components/ui';
import { useIsMobile } from '../lib/hooks';
import { useInvoices, useMonths, useOccurrences, useSummary } from '../lib/queries';
import { EditOccurrenceModal } from './EditOccurrenceModal';
import { InvoicesBlock } from './InvoicesBlock';
import { ItemFormModal } from './ItemFormModal';
import { OccurrenceList, OccurrenceTable } from './OccurrenceTable';
import { PayModal } from './PayModal';
import { SummaryCards } from './SummaryCards';

/**
 * Visão do mês (etapas 3, 5 e 6). Estado na URL para links de email e para o
 * botão voltar: ?mes=2026-11&aba=entradas.
 */
export function MonthPage({ walletId }: { walletId: string }) {
  const [params, setParams] = useSearchParams();
  const months = useMonths(walletId);
  const mobile = useIsMobile();
  // Abaixo de 1024px a tabela de 10 colunas não cabe: vira lista de cards.
  const compact = useIsMobile('(max-width: 1023px)');
  const current = months.data?.currentMonth ?? '';
  const requested = params.get('mes') ?? '';
  const month = isMonth(requested) ? requested : current;
  const type: ItemType = params.get('aba') === 'entradas' ? 'income' : 'expense';
  const [recurring, setRecurring] = useState(false);
  const [onlyOpen, setOnlyOpen] = useState(false);

  const occ = useOccurrences(walletId, { month, type, recurring, onlyOpen });
  const summary = useSummary(walletId, month);
  const invoices = useInvoices(walletId, month);

  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState<OccurrenceRow | null>(null);
  const [editing, setEditing] = useState<OccurrenceRow | null>(null);

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v === null) next.delete(k);
    else next.set(k, v);
    setParams(next, { replace: k === 'aba' });
  };
  const range = months.data;
  const canPrev = !!range && month > range.firstMonth;
  const canNext = !!range && month < range.lastMonth;
  const isFuture = !!current && month > current;

  const invoiceRows: InvoiceRow[] = useMemo(() => (invoices.data ?? []).filter((i) => i.itemCount > 0 || i.paidCents > 0 || i.totalCents > 0), [invoices.data]);

  if (!month) return <Loading />;
  const rows = occ.data ?? [];
  const typeLabel = type === 'expense' ? 'despesa' : 'entrada';

  return (
    <div className="app-content">
      <div className="app-pagehead">
        <div>
          <p className="ff-caption app-m0">Visão do mês</p>
          <h1 className="app-pagehead__title">{formatMonthLong(month)}</h1>
        </div>
        {/* O atalho fica à esquerda: aparecendo ou não, o seletor de mês não sai do lugar. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {month !== current && (
            <Button variant="ghost" size="sm" onClick={() => setParam('mes', null)}>
              Voltar para o mês atual
            </Button>
          )}
          <div className="ff-month" role="group" aria-label="Mês exibido">
            <IconButton icon="left" label="Mês anterior" disabled={!canPrev} onClick={() => setParam('mes', addMonths(month, -1))} />
            <span className="ff-month__label" aria-live="polite">
              {formatMonthLong(month)}
            </span>
            <IconButton icon="right" label="Próximo mês" disabled={!canNext} onClick={() => setParam('mes', addMonths(month, 1))} />
          </div>
        </div>
      </div>

      {isFuture && <Notice>Mês futuro: os valores são o que já está previsto (parcelas e recorrentes) e podem mudar.</Notice>}

      <SummaryCards summary={summary.data} onSeeType={(t) => setParam('aba', t === 'income' ? 'entradas' : null)} />

      {type === 'expense' && invoiceRows.length > 0 && <InvoicesBlock walletId={walletId} month={month} invoices={invoiceRows} />}

      <div className="app-toolbar">
        <div className="app-toolbar__left">
          <div className="ff-tabs" role="tablist" aria-label="Tipo de lançamento">
            <button type="button" className="ff-tab" role="tab" aria-selected={type === 'expense'} onClick={() => setParam('aba', null)}>
              Despesas
            </button>
            <button type="button" className="ff-tab" role="tab" aria-selected={type === 'income'} onClick={() => setParam('aba', 'entradas')}>
              Entradas
            </button>
          </div>
          <button type="button" className="ff-chip" aria-pressed={recurring} onClick={() => setRecurring((v) => !v)}>
            <Icon name="repeat" />
            Apenas recorrentes e parceladas
          </button>
          <button type="button" className="ff-chip" aria-pressed={onlyOpen} onClick={() => setOnlyOpen((v) => !v)}>
            <Icon name="clock" />
            {type === 'expense' ? 'Só a pagar' : 'Só a receber'}
          </button>
        </div>
        {!mobile && (
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
            Adicionar {typeLabel}
          </Button>
        )}
      </div>

      {occ.isError ? (
        <Notice tone="danger">{errorText(occ.error)}</Notice>
      ) : occ.isPending ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState
          title={recurring || onlyOpen ? 'Nada com esse filtro' : `Nenhuma ${typeLabel} neste mês`}
          action={
            !recurring && !onlyOpen ? (
              <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                Adicionar {typeLabel}
              </Button>
            ) : undefined
          }
        >
          {recurring || onlyOpen ? 'Tire o filtro para ver todos os lançamentos.' : 'Os lançamentos aparecem aqui assim que você adicionar.'}
        </EmptyState>
      ) : compact ? (
        <OccurrenceList rows={rows} onPay={setPaying} onOpen={setEditing} />
      ) : (
        <OccurrenceTable walletId={walletId} rows={rows} onPay={setPaying} onOpen={setEditing} />
      )}

      {mobile && (
        <Button variant="primary" className="ff-fab" aria-label={`Adicionar ${typeLabel}`} onClick={() => setCreating(true)}>
          <Icon name="plus" />
        </Button>
      )}

      {creating && <ItemFormModal walletId={walletId} type={type} month={month} currentMonth={current} onClose={() => setCreating(false)} />}
      {paying && <PayModal walletId={walletId} row={paying} rows={rows} onClose={() => setPaying(null)} />}
      {editing && (
        <EditOccurrenceModal
          walletId={walletId}
          row={editing}
          onClose={() => setEditing(null)}
          onPay={() => {
            setPaying(editing);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
