import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  METHODS,
  METHOD_LABEL,
  dateInMonth,
  formatDateBR,
  formatMonthShort,
  type Account,
  type Category,
  type ItemDetail,
  type ItemForm,
  type ItemType,
  type Method,
  type OccurrenceRow,
} from '@ff/shared';
import { Button, DayInput, Field, Modal, MoneyInput, MonthInput, Notice, Segmented, errorText, fieldErrors, useToast } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { todayISO } from '../lib/hooks';
import { invalidateFinance, useAccounts, useCategories, useInvoicePreview, walletUrl } from '../lib/queries';

/** Contexto da edição: a linha aberta, o item dela e os pedaços que só existem ao editar. */
export interface EditContext {
  row: OccurrenceRow;
  item: ItemDetail;
  /** Situação do mês (status, pagamentos), acima do formulário. */
  top?: ReactNode;
  /** Ações do lançamento (encerrar, mover, excluir), abaixo do formulário. */
  bottom?: ReactNode;
  /** Começo do rodapé (marcar como pago). */
  footerStart?: ReactNode;
}

type Props = { walletId: string; onClose: () => void } & ({ edit: EditContext } | { edit?: undefined; type: ItemType; month: string; currentMonth: string });

interface NewAccount {
  name: string;
  bank: string;
  closingDay: string;
  dueDay: string;
}

const BANKS = ['Banco do Brasil', 'Bradesco', 'XP', 'Nubank', 'Itaú', 'Caixa', 'Santander', 'Inter'];
const fieldError = (message: string, field: string) => Object.assign(new Error(message), { fields: { [field]: message } });

/**
 * Cadastro e edição de despesa ou entrada (etapa 3, ADR-0004). As datas dependem da forma:
 * - única: "Data" (+ "Data p/ pagamento" opcional na despesa fora do crédito);
 * - parcelada: no crédito, "Data da compra"; fora dele, uma só data, a da 1ª parcela
 *   (na edição, a desta parcela);
 * - recorrente: "Mês de início" + dia (do pagamento, opcional; do recebimento ou da
 *   cobrança, obrigatório).
 * No cadastro, "Já foi pago?" tem padrão pela regra: única no pix/débito com data até
 * hoje nasce paga; parcelas e recorrentes começam como promessa. Nas entradas únicas, a
 * própria data é a do recebimento (e do lembrete).
 * Na edição, mudar tipo, forma, parcelas, total, cartão, o mês de início, o dia da
 * cobrança ou a data de uma parcela recria os meses (o servidor recusa se já houver pagamento).
 */
export function ItemFormModal(props: Props) {
  const { walletId, onClose } = props;
  const e = props.edit;
  const toast = useToast();
  const qc = useQueryClient();
  const categories = useCategories(walletId);
  const accounts = useAccounts(walletId);
  const today = todayISO();

  const initialType: ItemType = e ? e.item.type : props.type;
  const initialMethod: Method = e ? e.item.method : initialType === 'income' ? 'transfer' : 'pix';
  // Lançando num mês que não é o atual, a data sugerida já cai nele.
  const defaultDate = e ? e.item.entryDate : props.month === props.currentMonth || !props.month ? today : `${props.month}-01`;
  // Entrada em edição: a data do recebimento é a deste mês.
  const initialReceipt = e
    ? (e.row.dueDate ?? (e.item.form === 'single' ? e.item.entryDate : dateInMonth(e.row.competenceMonth, Number(e.item.entryDate.slice(8, 10)))))
    : defaultDate;

  const [type, setType] = useState<ItemType>(initialType);
  const [form, setForm] = useState<ItemForm>(e ? e.item.form : 'single');
  const [description, setDescription] = useState(e ? e.item.description : '');
  const [amount, setAmount] = useState<number | null>(e ? (e.item.form === 'installment' ? e.item.totalCents : e.row.expectedCents) : null);
  const [occAmount, setOccAmount] = useState<number | null>(e ? e.row.expectedCents : null);
  const [installments, setInstallments] = useState(e?.item.installments ? String(e.item.installments) : '2');
  const [date, setDate] = useState(defaultDate);
  const [receipt, setReceipt] = useState(initialReceipt);
  const [dueDate, setDueDate] = useState(e && initialMethod !== 'credit' ? (e.row.dueDate ?? '') : '');
  // Parcelada fora do crédito, na edição: a data p/ pagamento da parcela aberta.
  // (Única que vira parcelada: começa pela data dela; parcelada antiga sem data continua vazia.)
  const [parcelDue, setParcelDue] = useState(e && initialMethod !== 'credit' ? (e.row.dueDate ?? (e.item.form === 'single' ? e.item.entryDate : '')) : '');
  // Recorrente: mês de início e dia (no crédito, o dia da cobrança fica na data de entrada).
  const entryDay = e ? Number(e.item.entryDate.slice(8, 10)) : null;
  const [startMonth, setStartMonth] = useState(e ? e.item.startMonth : props.month || props.currentMonth);
  const [day, setDay] = useState<number | null>(
    e ? (e.item.form === 'recurring' ? (e.item.method === 'credit' ? entryDay : e.item.dueDay) : e.row.dueDate && !e.row.invoice ? Number(e.row.dueDate.slice(8, 10)) : null) : null,
  );
  const [method, setMethod] = useState<Method>(initialMethod);
  const [accountId, setAccountId] = useState(e?.item.accountId ?? '');
  const [categoryId, setCategoryId] = useState(e?.item.categoryId ?? '');
  const [variable, setVariable] = useState(e ? e.item.variableAmount : false);
  const [note, setNote] = useState(e?.row.note ?? '');
  const [paidTouched, setPaidTouched] = useState(false);
  const [alreadyPaid, setAlreadyPaid] = useState(false);
  const [newCategory, setNewCategory] = useState<string | null>(null);
  const [newAccount, setNewAccount] = useState<NewAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const income = type === 'income';
  const credit = method === 'credit';
  const methods = METHODS.filter((m) => type === 'expense' || m !== 'credit');
  const accountOptions = useMemo(() => {
    const list: Array<Pick<Account, 'id' | 'name' | 'kind'>> = (accounts.data ?? []).filter((a) => (credit ? a.kind === 'credit_card' : a.kind === 'account'));
    // Na edição, a conta atual continua na lista mesmo arquivada (senão ela sumiria sem a pessoa pedir).
    const current = e?.row.account;
    if (current && current.id === e.item.accountId && (current.kind === 'credit_card') === credit && !list.some((a) => a.id === current.id)) list.push(current);
    return list;
  }, [accounts.data, credit, e]);
  const onlyCards = !credit && accountOptions.length === 0 && (accounts.data ?? []).some((a) => a.kind === 'credit_card');
  const catOptions: Category[] = (categories.data ?? []).filter((c) => c.type === type);
  const recurring = form === 'recurring';
  const nonCreditParcel = form === 'installment' && !credit;
  // Na recorrente no crédito, a fatura do mês de início sai do dia da cobrança.
  const previewDate = recurring ? (day ? dateInMonth(startMonth, day) : '') : date;
  const preview = useInvoicePreview(walletId, credit && !newAccount && previewDate ? accountId : null, previewDate);

  // Única: "data" e "data p/ pagamento" (nas entradas, as duas vêm da data do recebimento).
  const typeOrFormChanged = !!e && (type !== e.item.type || form !== e.item.form);
  const singleDate = income && e ? receipt : date;
  const singleDue = credit ? null : income ? (e ? receipt : date) : dueDate || null;
  // O que vai para a API como datas, conforme a forma (ADR-0004).
  const sentDates: Record<string, unknown> = recurring
    ? { startMonth, day }
    : nonCreditParcel
      ? e
        ? { dueDate: parcelDue || null }
        : { date }
      : form === 'single'
        ? { date: singleDate, dueDate: singleDue }
        : { date };

  // Mudanças que recriam os meses (espelha `editItem`/`datesChanged` no servidor).
  const datesChanged =
    !!e &&
    !typeOrFormChanged &&
    (recurring
      ? startMonth !== e.item.startMonth || (credit && day !== entryDay)
      : nonCreditParcel
        ? (parcelDue || null) !== (e.item.method === 'credit' ? null : e.row.dueDate)
        : credit && date !== e.item.entryDate);
  const structural =
    !!e &&
    (typeOrFormChanged ||
      credit !== (e.item.method === 'credit') ||
      (credit && (newAccount !== null || accountId !== (e.item.accountId ?? ''))) ||
      (form === 'installment' && (Number(installments) !== e.item.installments || amount !== e.item.totalCents)) ||
      datesChanged);
  const hasCanceledMonths = !!e && e.item.occurrences.some((o) => o.displayStatus === 'canceled');
  // Mesmas recusas do servidor, avisadas antes de salvar.
  const blocked = !e
    ? null
    : e.item.occurrences.some((o) => o.payments.length > 0)
      ? e.item.form === 'recurring'
        ? 'este lançamento já tem meses pagos. Encerre a recorrência e cadastre de novo.'
        : 'este lançamento já tem pagamento registrado. Desfaça o pagamento antes ou cadastre de novo.'
      : e.item.occurrences.some((o) => o.invoice && o.invoice.status !== 'open')
        ? 'parte deste lançamento está numa fatura já paga. Cancele as parcelas futuras e cadastre de novo.'
        : null;
  const editingParcel = !!e && e.item.form === 'installment' && form === 'installment';
  // Parcela aberta de uma parcelada que já era fora do crédito: a data é a desta parcela.
  const editingParcelDate = editingParcel && e!.item.method !== 'credit';

  // Padrão do "Já foi pago?" até a pessoa mexer nele (só no cadastro).
  const suggestedPaid = form === 'single' && ['pix', 'debit', 'cash', 'transfer'].includes(method) && (income || !dueDate) && date <= today;
  useEffect(() => {
    if (!paidTouched) setAlreadyPaid(suggestedPaid);
  }, [suggestedPaid, paidTouched]);
  useEffect(() => {
    if (!accounts.data || newAccount) return;
    if (credit && accountOptions.length === 1 && !accountOptions.some((a) => a.id === accountId)) setAccountId(accountOptions[0]!.id);
    else if (accountId && !accountOptions.some((a) => a.id === accountId)) setAccountId('');
  }, [accounts.data, credit, accountOptions, accountId, newAccount]);

  const verb = income ? 'recebido' : 'pago';
  const f = fieldErrors(err);
  const perInstallment = useMemo(() => (form === 'installment' && amount && Number(installments) >= 2 ? Math.floor(amount / Number(installments)) : null), [form, amount, installments]);

  async function createAccount(acc: NewAccount): Promise<string> {
    if (!acc.name.trim()) throw fieldError('Informe o nome.', 'accName');
    if (!acc.bank.trim()) throw fieldError('Informe o banco.', 'accBank');
    try {
      const days = credit ? { closingDay: Number(acc.closingDay) || undefined, dueDay: Number(acc.dueDay) || undefined } : {};
      const created = await api.post<Account>(`${walletUrl(walletId)}/accounts`, { name: acc.name.trim(), bank: acc.bank.trim(), kind: credit ? 'credit_card' : 'account', ...days });
      return created.id;
    } catch (ex) {
      // Os erros do cadastro de conta vão para os campos da conta nova, não para os do lançamento.
      if (ex instanceof ApiError) {
        const map: Record<string, string> = { name: 'accName', bank: 'accBank', closingDay: 'accClosing', dueDay: 'accDue' };
        const fields = Object.fromEntries(Object.entries(ex.fields).map(([k, v]) => [map[k] ?? k, v]));
        throw new ApiError(ex.status, ex.code, ex.message, fields);
      }
      throw ex;
    }
  }

  async function save() {
    setErr(null);
    if (!description.trim()) return setErr(fieldError('Informe o serviço.', 'description'));
    if (!amount) return setErr(fieldError('Informe o valor.', 'amountCents'));
    if (editingParcel && !structural && !occAmount) return setErr(fieldError('Informe o valor da parcela.', 'occurrenceCents'));
    if (recurring && !startMonth) return setErr(fieldError('Informe o mês de início.', 'startMonth'));
    if (recurring && day == null && (credit || income)) return setErr(fieldError(credit ? 'Informe o dia da cobrança.' : 'Informe o dia do recebimento.', 'day'));
    if (recurring && day != null && (day < 1 || day > 31)) return setErr(fieldError('Dia entre 1 e 31.', 'day'));
    if (!recurring && !(nonCreditParcel && e) && !date && !(income && e && receipt)) return setErr(fieldError('Informe a data.', 'date'));
    setBusy(true);
    try {
      let catId = categoryId || null;
      if (newCategory?.trim()) {
        const c = await api.post<Category>(`${walletUrl(walletId)}/categories`, { name: newCategory.trim(), type });
        catId = c.id;
        // Guarda a escolha: se o lançamento falhar, salvar de novo não cria a categoria duas vezes.
        await qc.invalidateQueries({ queryKey: ['categories', walletId] });
        setCategoryId(c.id);
        setNewCategory(null);
      }
      let accId = accountId || null;
      if (newAccount) {
        accId = await createAccount(newAccount);
        await qc.invalidateQueries({ queryKey: ['accounts', walletId] });
        setAccountId(accId);
        setNewAccount(null);
      }
      const common = {
        type,
        form,
        description: description.trim(),
        amountCents: amount,
        installments: form === 'installment' ? Number(installments) : undefined,
        variableAmount: form === 'recurring' ? variable : undefined,
        method,
        accountId: accId ?? undefined,
      };
      if (e) {
        await api.put(`${walletUrl(walletId)}/items/${e.item.id}`, {
          ...common,
          ...sentDates,
          accountId: accId,
          categoryId: catId,
          occurrenceId: e.row.id,
          occurrenceCents: editingParcel && occAmount ? occAmount : undefined,
          note: note.trim() || null,
          version: e.row.version,
        });
      } else {
        await api.post(`${walletUrl(walletId)}/items`, {
          ...common,
          categoryId: catId ?? undefined,
          ...sentDates,
          alreadyPaid: credit ? undefined : alreadyPaid,
          note: note.trim() || undefined,
        });
      }
      invalidateFinance(walletId);
      toast(e ? 'Alterações salvas.' : income ? 'Entrada adicionada.' : 'Despesa adicionada.');
      onClose();
    } catch (ex) {
      setErr(ex);
      setBusy(false);
    }
  }

  const errFields = (err as { fields?: Record<string, string> } | null)?.fields ?? f;
  const dateLabel = credit ? 'Data da compra' : 'Data';
  const dateValue = income && e ? receipt : date;
  const onDate = (v: string) => (income && e ? setReceipt(v) : setDate(v));
  const dateInput = (id: string) => <input id={id} type="date" className="ff-input ff-num" value={dateValue} onChange={(ev) => onDate(ev.target.value)} />;
  const amountLabel = form === 'installment' ? 'Valor total' : form === 'recurring' ? (e ? 'Valor do mês (vale daqui em diante)' : 'Valor do mês') : 'Valor';
  // Parcelada fora do crédito: uma só data, a da 1ª parcela (na edição, a desta parcela).
  const parcelLabel = editingParcelDate
    ? income
      ? 'Data do recebimento desta parcela'
      : 'Data p/ pagamento desta parcela'
    : income
      ? 'Data do recebimento da 1ª parcela'
      : 'Data p/ pagamento da 1ª parcela';
  const parcelValue = e ? parcelDue : date;
  const onParcel = (v: string) => (e ? setParcelDue(v) : setDate(v));
  // Recorrente: o dia muda de nome e de obrigatoriedade conforme o tipo e o método.
  const dayLabel = credit ? 'Dia da cobrança' : income ? 'Dia do recebimento' : 'Dia para o pagamento';
  const dayHint = credit
    ? 'Define a fatura de cada mês. Nos meses mais curtos, vale o último dia.'
    : `${e ? 'Vale deste mês em diante. ' : ''}${income ? '' : 'Sem dia, não há lembrete por email. '}Nos meses mais curtos, vale o último dia.`;
  const accountValue = newAccount ? '__new' : accountId;

  return (
    <Modal
      wide
      title={e ? e.row.description : income ? 'Adicionar entrada' : 'Adicionar despesa'}
      subtitle={e ? [e.row.category?.name, e.row.installmentLabel, METHOD_LABEL[e.row.method], e.row.account?.name].filter(Boolean).join(' · ') : undefined}
      onClose={onClose}
      footer={
        <>
          {e?.footerStart}
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" icon="check" onClick={save} busy={busy}>
            Salvar
          </Button>
        </>
      }
    >
      {e?.top}
      <Segmented
        label="Tipo"
        value={type}
        onChange={(t) => {
          setType(t);
          setCategoryId('');
          if (t === 'income' && method === 'credit') setMethod('transfer');
        }}
        options={[
          { value: 'expense', label: 'Despesa' },
          { value: 'income', label: 'Entrada' },
        ]}
      />
      <Field label={income ? 'Descrição' : 'Serviço'} htmlFor="it-desc" error={errFields.description}>
        <input id="it-desc" className="ff-input" value={description} onChange={(ev) => setDescription(ev.target.value)} placeholder={income ? 'Ex.: Salário' : 'Ex.: Conta de luz'} autoFocus={!e} />
      </Field>
      <Field label="Como é">
        <Segmented
          label="Forma"
          value={form}
          onChange={setForm}
          options={[
            { value: 'single', label: 'Única' },
            { value: 'installment', label: 'Parcelada' },
            { value: 'recurring', label: 'Todo mês' },
          ]}
        />
      </Field>
      <div className="app-grid2">
        <Field
          label={amountLabel}
          htmlFor="it-amount"
          error={errFields.amountCents}
          hint={perInstallment ? `${installments}x de cerca de R$ ${(perInstallment / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : undefined}
        >
          <MoneyInput id="it-amount" value={amount} onChange={setAmount} />
        </Field>
        {form === 'installment' ? (
          <Field label="Número de parcelas" htmlFor="it-inst" error={errFields.installments}>
            <input id="it-inst" className="ff-input" inputMode="numeric" value={installments} onChange={(ev) => setInstallments(ev.target.value.replace(/\D/g, '').slice(0, 3))} />
          </Field>
        ) : recurring ? (
          <Field label="Mês de início" htmlFor="it-start" error={errFields.startMonth} hint={e ? 'Mudar o mês de início recria os meses.' : undefined}>
            <MonthInput id="it-start" label="Mês de início" value={startMonth} onChange={setStartMonth} />
          </Field>
        ) : (
          <Field label={dateLabel} htmlFor="it-date" error={errFields.date ?? (income ? errFields.dueDate : undefined)}>
            {dateInput('it-date')}
          </Field>
        )}
      </div>
      {recurring && (
        <Field label={dayLabel} optional={!credit && !income} htmlFor="it-day" error={errFields.day} hint={dayHint}>
          <DayInput id="it-day" value={day} onChange={setDay} />
        </Field>
      )}
      {form === 'installment' && (
        <div className="app-grid2">
          {credit ? (
            <Field label={dateLabel} htmlFor="it-date2" error={errFields.date}>
              {dateInput('it-date2')}
            </Field>
          ) : (
            <Field label={parcelLabel} htmlFor="it-date2" error={errFields.date ?? errFields.dueDate} hint={editingParcelDate ? 'Mudar a data recalcula todas as parcelas.' : undefined}>
              <input id="it-date2" type="date" className="ff-input ff-num" value={parcelValue} onChange={(ev) => onParcel(ev.target.value)} />
            </Field>
          )}
          {editingParcel && (
            <Field
              label={`Valor desta parcela (${e!.row.installmentLabel})`}
              htmlFor="it-occ-amount"
              error={errFields.occurrenceCents}
              hint={structural ? 'Recalculado ao mudar o total ou as parcelas.' : undefined}
            >
              <MoneyInput id="it-occ-amount" value={occAmount} onChange={setOccAmount} disabled={structural} />
            </Field>
          )}
        </div>
      )}
      {form === 'recurring' && (
        <label className="app-checkbox">
          <input type="checkbox" checked={variable} onChange={(ev) => setVariable(ev.target.checked)} />O valor varia todo mês (luz, água): o próximo mês começa com o último valor {verb}
        </label>
      )}
      <div className="app-grid2">
        <Field label="Método" htmlFor="it-method" error={errFields.method}>
          <select id="it-method" className="ff-select" value={method} onChange={(ev) => setMethod(ev.target.value as Method)}>
            {methods.map((m) => (
              <option key={m} value={m}>
                {METHOD_LABEL[m]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={credit ? 'Cartão' : 'Banco / conta'}
          optional={!credit}
          htmlFor="it-account"
          error={errFields.accountId}
          hint={onlyCards && !newAccount ? 'Você só tem cartões cadastrados. Para Pix ou transferência, cadastre a conta.' : undefined}
        >
          <select
            id="it-account"
            className="ff-select"
            value={accountValue}
            onChange={(ev) => {
              if (ev.target.value === '__new') setNewAccount({ name: '', bank: '', closingDay: '', dueDay: '' });
              else {
                setNewAccount(null);
                setAccountId(ev.target.value);
              }
            }}
          >
            <option value="">{credit ? 'Escolha o cartão' : 'Nenhuma'}</option>
            {accountOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
            <option value="__new">{credit ? '+ Novo cartão' : '+ Nova conta'}</option>
          </select>
        </Field>
      </div>
      {newAccount && (
        <fieldset className="app-subform">
          <legend className="app-subform__title">{credit ? 'Novo cartão' : 'Nova conta'}</legend>
          <div className="app-grid2">
            <Field label="Nome" htmlFor="it-acc-name" error={errFields.accName} hint={credit ? 'Ex.: Nubank Crédito' : 'Ex.: Conta Nubank'}>
              <input id="it-acc-name" className="ff-input" value={newAccount.name} onChange={(ev) => setNewAccount({ ...newAccount, name: ev.target.value })} autoFocus />
            </Field>
            <Field label="Banco" htmlFor="it-acc-bank" error={errFields.accBank}>
              <input id="it-acc-bank" className="ff-input" list="it-banks" value={newAccount.bank} onChange={(ev) => setNewAccount({ ...newAccount, bank: ev.target.value })} />
              <datalist id="it-banks">
                {BANKS.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </Field>
          </div>
          {credit && (
            <div className="app-grid2">
              <Field label="Dia do fechamento" htmlFor="it-acc-close" error={errFields.accClosing}>
                <input id="it-acc-close" className="ff-input" inputMode="numeric" value={newAccount.closingDay} onChange={(ev) => setNewAccount({ ...newAccount, closingDay: ev.target.value.replace(/\D/g, '').slice(0, 2) })} />
              </Field>
              <Field label="Dia do vencimento" htmlFor="it-acc-due" error={errFields.accDue}>
                <input id="it-acc-due" className="ff-input" inputMode="numeric" value={newAccount.dueDay} onChange={(ev) => setNewAccount({ ...newAccount, dueDay: ev.target.value.replace(/\D/g, '').slice(0, 2) })} />
              </Field>
            </div>
          )}
          <p className="ff-caption app-m0">{credit ? 'O cartão é cadastrado' : 'A conta é cadastrada'} ao salvar e fica em Contas e cartões.</p>
          <div>
            <Button variant="ghost" size="sm" onClick={() => setNewAccount(null)}>
              Escolher {credit ? 'um cartão' : 'uma conta'} da lista
            </Button>
          </div>
        </fieldset>
      )}
      {credit && accountOptions.length === 0 && !newAccount && <Notice tone="danger">Cadastre um cartão para lançar no crédito: escolha "+ Novo cartão" acima.</Notice>}
      {credit && preview.data && (
        <Notice>
          Vai para a fatura de {formatMonthShort(preview.data.referenceMonth, true)}, que vence em {formatDateBR(preview.data.dueDate)}
          {form === 'installment' ? '. As outras parcelas vão para as faturas seguintes.' : '.'}
        </Notice>
      )}
      {structural && (
        <Notice tone={blocked ? 'danger' : 'info'}>
          {blocked
            ? `Essa mudança recalcula todos os meses, mas ${blocked}`
            : `Essa mudança recalcula todos os meses deste lançamento${credit || e!.item.method === 'credit' ? ' e as faturas' : ''}.${
                recurring && e!.item.form === 'recurring' && hasCanceledMonths ? ' Os meses excluídos continuam excluídos.' : ''
              }`}
        </Notice>
      )}
      {form === 'single' && !credit && !income && (
        <Field label="Data p/ pagamento" optional htmlFor="it-due" hint="Com data, você recebe o lembrete por email." error={errFields.dueDate}>
          <input id="it-due" type="date" className="ff-input ff-num" value={dueDate} onChange={(ev) => setDueDate(ev.target.value)} />
        </Field>
      )}
      <Field label="Categoria" optional htmlFor="it-cat" error={errFields.categoryId}>
        {newCategory === null ? (
          <select
            id="it-cat"
            className="ff-select"
            value={categoryId}
            onChange={(ev) => {
              if (ev.target.value === '__new') setNewCategory('');
              else setCategoryId(ev.target.value);
            }}
          >
            <option value="">Sem categoria</option>
            {catOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value="__new">+ Nova categoria</option>
          </select>
        ) : (
          <span style={{ display: 'flex', gap: 8 }}>
            <input id="it-cat" className="ff-input" placeholder="Nome da nova categoria" value={newCategory} onChange={(ev) => setNewCategory(ev.target.value)} autoFocus />
            <Button variant="ghost" onClick={() => setNewCategory(null)}>
              Voltar
            </Button>
          </span>
        )}
      </Field>
      {!credit && !e && (
        <Field label={income ? 'Já foi recebido?' : 'Já foi pago?'}>
          <Segmented
            label={income ? 'Já foi recebido?' : 'Já foi pago?'}
            value={alreadyPaid ? 'yes' : 'no'}
            onChange={(v) => {
              setPaidTouched(true);
              setAlreadyPaid(v === 'yes');
            }}
            options={[
              { value: 'yes', label: 'Sim' },
              { value: 'no', label: 'Não' },
            ]}
          />
        </Field>
      )}
      <Field label={e ? 'Observação deste mês' : 'Observação'} optional htmlFor="it-note">
        <textarea id="it-note" className="ff-input" value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={500} placeholder={e ? 'Ex.: veio com multa' : undefined} />
      </Field>
      {err && !Object.keys(errFields).length ? <Notice tone="danger">{errorText(err)}</Notice> : null}
      {e?.bottom}
    </Modal>
  );
}
