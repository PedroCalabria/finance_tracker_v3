import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  METHODS,
  METHOD_LABEL,
  formatMonthLong,
  importQuestions,
  type ImportAction,
  type ImportConfirmResult,
  type ImportLineView,
  type ImportPreview,
  type ImportSuggestions,
  type ImportTarget,
  type Method,
} from '@ff/shared';
import { Icon } from '../components/Icon';
import { Button, Field, Notice, Segmented, brl, dateBR, errorText, useToast } from '../components/ui';
import { ApiError, api, request } from '../lib/api';
import { useIsMobile } from '../lib/hooks';
import { invalidateFinance, useCategories, walletUrl } from '../lib/queries';

/**
 * Importar extrato ou fatura (ADR-0010, ADR-0009): arquivo → destino →
 * conciliação → resultado. O arquivo, a senha e a prévia ficam só na memória da
 * página (nada em localStorage). Nada é gravado antes de "Confirmar importação".
 */

interface Decision {
  action: ImportAction;
  /** Alvo escolhido (lançamento ou fatura). */
  target: ImportTarget | null;
  description: string;
  categoryId: string;
  method: Method;
  amountScope?: 'occurrence' | 'forward';
  settlement?: 'discount' | 'partial';
}

const GROUPS: Array<{ key: string; title: string }> = [
  { key: 'match', title: 'Casar com lançamento' },
  { key: 'create', title: 'Criar lançamento' },
  { key: 'invoice_payment', title: 'Pagamento de fatura' },
  { key: 'refund', title: 'Créditos e estornos' },
  { key: 'ignore', title: 'Ignorar' },
];

const targetKey = (t: ImportTarget) => (t.kind === 'occurrence' ? `o:${t.occurrenceId}:${t.alreadyPaid?.paymentId ?? ''}` : `i:${t.invoiceId}`);
const targetLabel = (t: ImportTarget) =>
  t.kind === 'occurrence'
    ? `${t.description} · ${formatMonthLong(t.competenceMonth).toLowerCase()} · ${brl(t.alreadyPaid?.amountCents ?? t.remainingCents)}${t.alreadyPaid ? ' (já pago no app)' : t.projected ? ' (previsto)' : ''}`
    : `Fatura ${t.accountName} · vence ${dateBR(t.dueDate)} · ${brl(t.realAmountCents ?? t.totalCents)}`;

function initialDecisions(s: ImportSuggestions): Map<number, Decision> {
  return new Map(
    s.lines.map((l) => [
      l.index,
      {
        action: l.suggestion.action,
        target: l.suggestion.target,
        description: l.suggestion.create.description,
        categoryId: l.suggestion.create.categoryId ?? '',
        method: l.suggestion.create.method,
      },
    ]),
  );
}

export function ImportPage({ walletId }: { walletId: string }) {
  const toast = useToast();
  const navigate = useNavigate();
  const narrow = useIsMobile('(max-width: 1023px)');
  const categories = useCategories(walletId);
  const W = walletUrl(walletId);
  const fileInput = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [needPassword, setNeedPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>('');
  const [passwordErr, setPasswordErr] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [accountId, setAccountId] = useState('');
  const [sugg, setSugg] = useState<ImportSuggestions | null>(null);
  const [decisions, setDecisions] = useState<Map<number, Decision>>(new Map());
  const [useBankDates, setUseBankDates] = useState(true);
  const [errLine, setErrLine] = useState<{ index: number; message: string } | null>(null);
  const [result, setResult] = useState<ImportConfirmResult | null>(null);

  function reset() {
    setFile(null);
    setNeedPassword(false);
    setPassword('');
    setPreview(null);
    setSugg(null);
    setResult(null);
    setErr('');
    setErrLine(null);
  }

  async function read(f: File, pw?: string) {
    setBusy(true);
    setErr('');
    setPasswordErr('');
    try {
      const fd = new FormData();
      // A senha vai antes do arquivo; fica só nesta chamada.
      if (pw) fd.append('password', pw);
      fd.append('file', f);
      const p = await request<ImportPreview>('POST', `${W}/imports/preview`, fd);
      setPreview(p);
      setNeedPassword(false);
      setPassword('');
      setAccountId(p.destinations.suggestedAccountId ?? '');
      setSugg(p.suggestions);
      if (p.suggestions) setDecisions(initialDecisions(p.suggestions));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'pdf_password_required') setNeedPassword(true);
      else if (e instanceof ApiError && e.code === 'pdf_password_incorrect') setPasswordErr(e.message);
      else setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function pick(f: File | undefined | null) {
    if (!f) return;
    setFile(f);
    void read(f);
  }

  async function chooseDestination(id: string) {
    setAccountId(id);
    setSugg(null);
    if (!id || !preview) return;
    setBusy(true);
    try {
      const s = await api.post<ImportSuggestions>(`${W}/imports/suggest`, { token: preview.token, accountId: id });
      setSugg(s);
      setDecisions(initialDecisions(s));
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const update = (index: number, patch: Partial<Decision>) =>
    setDecisions((prev) => {
      const next = new Map(prev);
      next.set(index, { ...prev.get(index)!, ...patch });
      return next;
    });

  // Perguntas sem resposta: o botão de confirmar espera por elas.
  const pending = useMemo(() => {
    if (!sugg) return [];
    return sugg.lines.filter((l) => {
      const d = decisions.get(l.index);
      if (!d) return false;
      if (d.action === 'create') return !d.description.trim();
      if (d.action === 'invoice_payment') return !d.target;
      if (d.action !== 'match') return false;
      if (!d.target) return true;
      const q = importQuestions(l.amountCents, d.target);
      return (q.includes('amount_scope') && !d.amountScope) || (q.includes('settlement') && !d.settlement);
    });
  }, [sugg, decisions]);

  const groupOf = (l: ImportLineView): string => {
    const d = decisions.get(l.index);
    if (l.suggestion.action === 'already') return 'already';
    if (sugg?.kind === 'invoice' && l.direction === 'credit' && d?.action === 'ignore') return 'refund';
    return d?.action ?? 'ignore';
  };

  const totals = useMemo(() => {
    const t = { import: { n: 0, cents: 0 }, ignore: { n: 0, cents: 0 }, already: { n: 0, cents: 0 } };
    for (const l of sugg?.lines ?? []) {
      const g = groupOf(l);
      const bucket = g === 'already' ? t.already : g === 'ignore' || g === 'refund' ? t.ignore : t.import;
      bucket.n++;
      bucket.cents += l.amountCents;
    }
    return t;
  }, [sugg, decisions]); // groupOf depende só destes dois

  async function confirm() {
    if (!preview || !sugg) return;
    setBusy(true);
    setErr('');
    setErrLine(null);
    try {
      const body = {
        token: preview.token,
        accountId,
        decisions: sugg.lines
          .filter((l) => l.suggestion.action !== 'already')
          .map((l) => {
            const d = decisions.get(l.index)!;
            const base: Record<string, unknown> = { index: l.index, action: d.action };
            if (d.action === 'match' && d.target?.kind === 'occurrence') {
              base.occurrenceId = d.target.occurrenceId;
              if (d.amountScope) base.amountScope = d.amountScope;
              if (d.settlement) base.settlement = d.settlement;
            }
            if (d.action === 'invoice_payment' && d.target?.kind === 'invoice') base.invoiceId = d.target.invoiceId;
            if (d.action === 'create') base.create = { description: d.description.trim(), categoryId: d.categoryId || null, method: d.method };
            return base;
          }),
        invoice: sugg.invoice ? { useBankDates, realAmountCents: sugg.invoice.bankTotalCents } : undefined,
      };
      const r = await api.post<ImportConfirmResult>(`${W}/imports/confirm`, body);
      invalidateFinance(walletId);
      setResult(r);
      toast('Importação concluída.');
    } catch (e) {
      const field = e instanceof ApiError ? Object.entries(e.fields).find(([k]) => k.startsWith('decisions.')) : undefined;
      if (field) {
        const index = Number(field[0].split('.')[1]);
        setErrLine({ index, message: field[1] });
        document.getElementById(`imp-line-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  // ---------- Resultado
  if (result) {
    const c = result.counts;
    const month = result.months[0];
    const parts = [
      c.paid && `${c.paid} ${c.paid === 1 ? 'pagamento registrado' : 'pagamentos registrados'}`,
      c.created && `${c.created} ${c.created === 1 ? 'lançamento criado' : 'lançamentos criados'}`,
      c.linked && `${c.linked} ${c.linked === 1 ? 'vinculado' : 'vinculados'}`,
      c.invoicePaid && `${c.invoicePaid} ${c.invoicePaid === 1 ? 'fatura paga' : 'faturas pagas'}`,
      c.ignored && `${c.ignored} ${c.ignored === 1 ? 'ignorada' : 'ignoradas'}`,
      c.already && `${c.already} já ${c.already === 1 ? 'conciliada' : 'conciliadas'}`,
    ].filter(Boolean);
    return (
      <div className="app-content">
        <div className="app-pagehead">
          <h1 className="app-pagehead__title">Importação concluída</h1>
        </div>
        <section className="ff-card app-import-card">
          <p className="app-m0">{parts.join(', ') || 'Nada a gravar.'}.</p>
          <div className="app-actions-row">
            {month && (
              <Button variant="primary" onClick={() => navigate(`/?mes=${month}`)}>
                Ver o mês de {formatMonthLong(month).toLowerCase()}
              </Button>
            )}
            <Button variant="ghost" icon="upload" onClick={reset}>
              Importar outro arquivo
            </Button>
          </div>
        </section>
      </div>
    );
  }

  // ---------- Envio do arquivo
  if (!preview) {
    return (
      <div className="app-content">
        <div className="app-pagehead">
          <h1 className="app-pagehead__title">Importar extrato ou fatura</h1>
        </div>
        <section className="ff-card app-import-card">
          <label
            className="ff-upload app-dropzone"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              pick(e.dataTransfer.files[0]);
            }}
          >
            <Icon name="upload" />
            {busy ? 'Lendo o arquivo…' : file ? file.name : 'Arraste o arquivo ou clique para escolher'}
            <input ref={fileInput} type="file" accept=".pdf,.ofx,application/pdf" className="app-sr" disabled={busy} onChange={(e) => pick(e.target.files?.[0])} />
          </label>
          <p className="ff-caption app-m0">Extrato ou fatura do Banco do Brasil em PDF, ou OFX de qualquer banco · até 10 MB. O arquivo é lido no servidor e não fica guardado.</p>
          {needPassword && file && (
            <form
              className="app-import-password"
              onSubmit={(e) => {
                e.preventDefault();
                void read(file, password);
              }}
            >
              <Notice>Este PDF tem senha.</Notice>
              <Field label="Senha do PDF" htmlFor="imp-pw" error={passwordErr}>
                <input id="imp-pw" type="password" className="ff-input" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
              </Field>
              <div>
                <Button variant="primary" type="submit" busy={busy} disabled={!password}>
                  Abrir
                </Button>
              </div>
            </form>
          )}
          {err && <Notice tone="danger">{err}</Notice>}
        </section>
      </div>
    );
  }

  // ---------- Destino e conciliação
  const isInvoice = preview.source.kind === 'invoice';
  const options = preview.destinations.options;
  const catsFor = (type: 'expense' | 'income') => (categories.data ?? []).filter((c) => c.type === type);
  const linesByGroup = (key: string) => (sugg?.lines ?? []).filter((l) => groupOf(l) === key);
  const already = linesByGroup('already');

  const decisionControl = (l: ImportLineView): ReactNode => {
    const d = decisions.get(l.index)!;
    const s = l.suggestion;
    const occTargets = [s.target, ...s.alternatives].filter((t): t is ImportTarget => !!t && t.kind === 'occurrence');
    const invTargets = [...(s.target?.kind === 'invoice' ? [s.target] : []), ...(sugg?.invoiceTargets ?? [])].filter(
      (t, i, all) => all.findIndex((x) => targetKey(x) === targetKey(t)) === i,
    );
    const actions: Array<{ value: ImportAction; label: string }> = [];
    if (occTargets.length) actions.push({ value: 'match', label: 'Casar com lançamento' });
    actions.push({ value: 'create', label: isInvoice && l.direction === 'credit' ? 'Criar (não permitido)' : 'Criar lançamento' });
    if (!isInvoice && invTargets.length) actions.push({ value: 'invoice_payment', label: 'Pagamento de fatura' });
    actions.push({ value: 'ignore', label: isInvoice && l.direction === 'credit' ? 'Ignorar (entra no ajuste)' : 'Ignorar' });
    const questions = d.action === 'match' ? importQuestions(l.amountCents, d.target) : [];
    const id = `imp-${l.index}`;
    return (
      <div className="app-import-decision">
        <select
          id={`${id}-action`}
          className="ff-select"
          aria-label={`O que fazer com ${l.description}`}
          value={d.action}
          onChange={(e) => {
            const action = e.target.value as ImportAction;
            const target = action === 'match' ? (occTargets[0] ?? null) : action === 'invoice_payment' ? (invTargets[0] ?? null) : null;
            update(l.index, { action, target, amountScope: undefined, settlement: undefined });
          }}
        >
          {actions.map((a) => (
            <option key={a.value} value={a.value} disabled={a.label.includes('não permitido')}>
              {a.label}
            </option>
          ))}
        </select>
        {d.action === 'match' && occTargets.length > 1 && (
          <select
            className="ff-select"
            aria-label="Lançamento"
            value={d.target ? targetKey(d.target) : ''}
            onChange={(e) => update(l.index, { target: occTargets.find((t) => targetKey(t) === e.target.value) ?? null, amountScope: undefined, settlement: undefined })}
          >
            {occTargets.map((t) => (
              <option key={targetKey(t)} value={targetKey(t)}>
                {targetLabel(t)}
              </option>
            ))}
          </select>
        )}
        {d.action === 'match' && occTargets.length === 1 && d.target && <span className="ff-caption">{targetLabel(d.target)}</span>}
        {d.action === 'invoice_payment' && (
          <select className="ff-select" aria-label="Fatura" value={d.target ? targetKey(d.target) : ''} onChange={(e) => update(l.index, { target: invTargets.find((t) => targetKey(t) === e.target.value) ?? null })}>
            {invTargets.map((t) => (
              <option key={targetKey(t)} value={targetKey(t)}>
                {targetLabel(t)}
              </option>
            ))}
          </select>
        )}
        {questions.includes('amount_scope') && (
          <Segmented
            label="O valor novo vale"
            value={d.amountScope ?? ('' as 'occurrence')}
            onChange={(v) => update(l.index, { amountScope: v })}
            options={[
              { value: 'occurrence', label: 'Só este mês' },
              { value: 'forward', label: 'Daqui em diante' },
            ]}
          />
        )}
        {questions.includes('settlement') && (
          <Segmented
            label="Valor menor que o previsto"
            value={d.settlement ?? ('' as 'discount')}
            onChange={(v) => update(l.index, { settlement: v })}
            options={[
              { value: 'discount', label: 'Quitado com desconto' },
              { value: 'partial', label: 'Pagamento parcial' },
            ]}
          />
        )}
        {d.action === 'create' && (
          <div className="app-import-create">
            <input className="ff-input" aria-label="Descrição" value={d.description} maxLength={120} onChange={(e) => update(l.index, { description: e.target.value })} />
            <select className="ff-select" aria-label="Categoria" value={d.categoryId} onChange={(e) => update(l.index, { categoryId: e.target.value })}>
              <option value="">Sem categoria</option>
              {catsFor(l.direction === 'debit' ? 'expense' : 'income').map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {!isInvoice && (
              <select className="ff-select" aria-label="Método" value={d.method} onChange={(e) => update(l.index, { method: e.target.value as Method })}>
                {METHODS.filter((m) => m !== 'credit').map((m) => (
                  <option key={m} value={m}>
                    {METHOD_LABEL[m]}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
        {(d.action === l.suggestion.action ? s.warnings : []).map((w) => (
          <span key={w} className="ff-caption app-import-warn">
            {w}
          </span>
        ))}
        {l.explanation && d.action === 'ignore' && <span className="ff-caption">{l.explanation}</span>}
        {errLine?.index === l.index && (
          <span className="ff-field__error" role="alert">
            <Icon name="alert" />
            {errLine.message}
          </span>
        )}
      </div>
    );
  };

  const isPending = (l: ImportLineView) => pending.includes(l);
  const amount = (l: ImportLineView) => (
    <span className={`ff-num${l.direction === 'credit' ? ' app-import-in' : ''}`}>
      {l.direction === 'credit' ? '+' : '−'} {brl(l.amountCents)}
    </span>
  );

  const group = (key: string, title: string, lines: ImportLineView[]) =>
    lines.length === 0 ? null : (
      <section key={key} className="ff-card">
        <header className="ff-card__header">
          <h2 className="ff-card__title">{title}</h2>
          <span className="ff-caption">
            {lines.length} · {brl(lines.reduce((s, l) => s + l.amountCents, 0))}
          </span>
        </header>
        {narrow ? (
          <div>
            {lines.map((l) => (
              <article key={l.index} id={`imp-line-${l.index}`} className={`ff-occ app-import-row${isPending(l) || errLine?.index === l.index ? ' is-pending' : ''}`}>
                <p className="ff-occ__kicker">{dateBR(l.date)}</p>
                <p className="ff-occ__name" title={l.description}>
                  {l.description}
                </p>
                <p className="ff-occ__amount">{amount(l)}</p>
                <div className="ff-occ__foot">{decisionControl(l)}</div>
              </article>
            ))}
          </div>
        ) : (
          <div className="ff-table-wrap">
            <table className="ff-table app-import-table">
              <thead>
                <tr>
                  <th scope="col">Data</th>
                  <th scope="col">Descrição no banco</th>
                  <th scope="col" className="ff-num">
                    Valor
                  </th>
                  <th scope="col">O que fazer</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.index} id={`imp-line-${l.index}`} className={isPending(l) || errLine?.index === l.index ? 'is-pending' : undefined}>
                    <td className="ff-num">{dateBR(l.date, true)}</td>
                    <td>
                      {l.description}
                      {l.section && <span className="ff-caption app-block">{l.section}</span>}
                    </td>
                    <td className="ff-num">{amount(l)}</td>
                    <td>{decisionControl(l)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    );

  const inv = sugg?.invoice;
  const createdCents = (sugg?.lines ?? []).filter((l) => decisions.get(l.index)?.action === 'create' && l.suggestion.action !== 'already').reduce((s, l) => s + l.amountCents, 0);
  const datesDiffer = !!inv && (inv.bankClosingDate !== inv.appClosingDate || inv.bankDueDate !== inv.appDueDate);

  return (
    <div className="app-content">
      <div className="app-pagehead">
        <h1 className="app-pagehead__title">Importar extrato ou fatura</h1>
        <Button variant="ghost" icon="upload" onClick={reset}>
          Outro arquivo
        </Button>
      </div>

      <section className="ff-card app-import-card">
        <p className="app-m0">
          <strong>{preview.source.label}</strong>
          {preview.header.invoice
            ? ` · ${preview.header.accountLabel ?? ''} · vence ${dateBR(preview.header.invoice.dueDate)} · ${brl(preview.header.invoice.totalCents)}`
            : preview.header.periodStart && preview.header.periodEnd
              ? ` · ${dateBR(preview.header.periodStart)} a ${dateBR(preview.header.periodEnd)}${preview.header.accountLabel ? ` · ${preview.header.accountLabel}` : ''}`
              : ''}
          {` · ${preview.lineCount} ${preview.lineCount === 1 ? 'linha' : 'linhas'}`}
        </p>
        {preview.warnings.map((w, i) => (
          <Notice key={i} tone="danger">
            {w.message} {w.date ? `Dia ${dateBR(w.date)}: ` : ''}diferença de {brl(Math.abs(w.diffCents))}.
          </Notice>
        ))}
        {options.length === 0 ? (
          <Notice tone="danger">
            {isInvoice ? 'Cadastre o cartão para importar a fatura.' : 'Cadastre a conta para importar o extrato.'}{' '}
            <button type="button" className="ff-link" onClick={() => navigate('/contas')}>
              {isInvoice ? '+ Novo cartão' : '+ Nova conta'}
            </button>
          </Notice>
        ) : (
          <Field label={isInvoice ? 'Cartão' : 'Conta'} htmlFor="imp-dest" hint={!accountId ? 'Escolha para ver as sugestões.' : undefined}>
            <select id="imp-dest" className="ff-select" value={accountId} onChange={(e) => void chooseDestination(e.target.value)} disabled={busy}>
              <option value="">{isInvoice ? 'Escolha o cartão' : 'Escolha a conta'}</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} · {o.bank}
                </option>
              ))}
            </select>
          </Field>
        )}
        {err && <Notice tone="danger">{err}</Notice>}
      </section>

      {busy && !sugg && <p className="ff-caption">Carregando sugestões…</p>}

      {sugg && (
        <>
          <div className="app-import-totals" role="status">
            <div className="ff-card">
              <p className="ff-caption app-m0">A importar</p>
              <p className="app-import-total">{totals.import.n}</p>
              <p className="ff-caption app-m0">{brl(totals.import.cents)}</p>
            </div>
            <div className="ff-card">
              <p className="ff-caption app-m0">Ignoradas</p>
              <p className="app-import-total">{totals.ignore.n}</p>
              <p className="ff-caption app-m0">{brl(totals.ignore.cents)}</p>
            </div>
            <div className="ff-card">
              <p className="ff-caption app-m0">Já conciliadas</p>
              <p className="app-import-total">{totals.already.n}</p>
              <p className="ff-caption app-m0">{brl(totals.already.cents)}</p>
            </div>
          </div>

          {inv && (
            <section className="ff-card app-import-card">
              <dl className="app-kv">
                <dt>Total do banco</dt>
                <dd>{brl(inv.bankTotalCents)}</dd>
                <dt>Itens no app depois da importação</dt>
                <dd>{brl(inv.itemsCents + createdCents)}</dd>
                <dt>Diferença (vai para o ajuste da fatura)</dt>
                <dd>{brl(inv.bankTotalCents - inv.itemsCents - createdCents)}</dd>
              </dl>
              {inv.status !== 'open' && <Notice>Esta fatura já foi paga no app: só dá para vincular linhas.</Notice>}
              {datesDiffer && inv.status === 'open' && (
                <label className="app-checkbox">
                  <input type="checkbox" checked={useBankDates} onChange={(e) => setUseBankDates(e.target.checked)} />
                  Usar as datas do banco: fecha {dateBR(inv.bankClosingDate)} e vence {dateBR(inv.bankDueDate)} (no app: {dateBR(inv.appClosingDate)} e {dateBR(inv.appDueDate)})
                </label>
              )}
            </section>
          )}

          {GROUPS.map((g) => group(g.key, g.title, linesByGroup(g.key)))}

          {already.length > 0 && (
            <details className="ff-card app-import-details">
              <summary className="ff-card__header">
                <span className="ff-card__title">Já conciliadas</span>
                <span className="ff-caption">
                  {already.length} · {brl(already.reduce((s, l) => s + l.amountCents, 0))}
                </span>
              </summary>
              <ul className="app-import-list">
                {already.map((l) => (
                  <li key={l.index}>
                    <span className="ff-num">{dateBR(l.date, true)}</span> {l.description} <span className="ff-num">{brl(l.amountCents)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {sugg.unmatchedApp.length > 0 && (
            <details className="ff-card app-import-details" open>
              <summary className="ff-card__header">
                <span className="ff-card__title">{isInvoice ? 'No app, mas não na fatura' : 'No app, mas não no extrato'}</span>
                <span className="ff-caption">{sugg.unmatchedApp.length}</span>
              </summary>
              <ul className="app-import-list">
                {sugg.unmatchedApp.map((u) => (
                  <li key={`${u.occurrenceId}-${u.paidAt ?? ''}`}>
                    {u.description} · {dateBR(u.paidAt ?? u.date, true)} · <span className="ff-num">{brl(u.amountCents)}</span>
                  </li>
                ))}
              </ul>
              <p className="ff-caption app-import-hint">
                {isInvoice ? 'Confira se o item foi lançado no cartão certo; para mover ou excluir, abra o lançamento no mês.' : 'Confira se o pagamento foi marcado na conta certa.'}
              </p>
            </details>
          )}

          <div className="app-import-confirm">
            {pending.length > 0 && (
              <span className="ff-caption">
                Responda {pending.length} {pending.length === 1 ? 'linha' : 'linhas'}
              </span>
            )}
            <Button variant="primary" icon="check" onClick={confirm} busy={busy} disabled={pending.length > 0 || !accountId}>
              Confirmar importação
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
