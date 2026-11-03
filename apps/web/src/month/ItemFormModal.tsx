import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { METHODS, METHOD_LABEL, formatDateBR, formatMonthShort, type Category, type ItemForm, type ItemType, type Method } from '@ff/shared';
import { Button, Field, Modal, MoneyInput, Notice, Segmented, errorText, fieldErrors, useToast } from '../components/ui';
import { api } from '../lib/api';
import { todayISO } from '../lib/hooks';
import { invalidateFinance, useAccounts, useCategories, useInvoicePreview, walletUrl } from '../lib/queries';

/**
 * Cadastro de despesa ou entrada (etapa 3). Obrigatórios: serviço, valor, data e
 * método. "Já foi pago?" tem padrão pela regra (ADR-0004): única no pix/débito
 * com data até hoje nasce paga; parcelas e recorrentes começam como promessa.
 */
export function ItemFormModal({ walletId, type: initialType, month, currentMonth, onClose }: { walletId: string; type: ItemType; month: string; currentMonth: string; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const categories = useCategories(walletId);
  const accounts = useAccounts(walletId);
  const today = todayISO();
  // Lançando num mês que não é o atual, a data sugerida já cai nele.
  const defaultDate = month === currentMonth || !month ? today : `${month}-01`;

  const [type, setType] = useState<ItemType>(initialType);
  const [form, setForm] = useState<ItemForm>('single');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [installments, setInstallments] = useState('2');
  const [date, setDate] = useState(defaultDate);
  const [dueDate, setDueDate] = useState('');
  const [method, setMethod] = useState<Method>(initialType === 'income' ? 'transfer' : 'pix');
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [variable, setVariable] = useState(false);
  const [note, setNote] = useState('');
  const [paidTouched, setPaidTouched] = useState(false);
  const [alreadyPaid, setAlreadyPaid] = useState(false);
  const [newCategory, setNewCategory] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const credit = method === 'credit';
  const methods = METHODS.filter((m) => type === 'expense' || m !== 'credit');
  const accountOptions = (accounts.data ?? []).filter((a) => (credit ? a.kind === 'credit_card' : a.kind === 'account'));
  const catOptions: Category[] = (categories.data ?? []).filter((c) => c.type === type);
  const preview = useInvoicePreview(walletId, credit ? accountId : null, date);

  // Padrão do "Já foi pago?" até a pessoa mexer nele.
  const suggestedPaid = form === 'single' && ['pix', 'debit', 'cash', 'transfer'].includes(method) && !dueDate && date <= today;
  useEffect(() => {
    if (!paidTouched) setAlreadyPaid(suggestedPaid);
  }, [suggestedPaid, paidTouched]);
  useEffect(() => {
    if (credit && accountOptions.length === 1 && !accountOptions.some((a) => a.id === accountId)) setAccountId(accountOptions[0]!.id);
    if (!accountOptions.some((a) => a.id === accountId) && accountId) setAccountId('');
  }, [credit, accountOptions, accountId]);

  const verb = type === 'income' ? 'recebido' : 'pago';
  const f = fieldErrors(err);
  const perInstallment = useMemo(() => (form === 'installment' && amount && Number(installments) >= 2 ? Math.floor(amount / Number(installments)) : null), [form, amount, installments]);

  async function save() {
    setErr(null);
    if (!description.trim()) return setErr(Object.assign(new Error('Informe o serviço.'), { fields: { description: 'Informe o serviço.' } }));
    if (!amount) return setErr(Object.assign(new Error('Informe o valor.'), { fields: { amountCents: 'Informe o valor.' } }));
    setBusy(true);
    try {
      let catId = categoryId || null;
      if (newCategory?.trim()) {
        const c = await api.post<Category>(`${walletUrl(walletId)}/categories`, { name: newCategory.trim(), type });
        catId = c.id;
        void qc.invalidateQueries({ queryKey: ['categories', walletId] });
      }
      await api.post(`${walletUrl(walletId)}/items`, {
        type,
        form,
        description: description.trim(),
        amountCents: amount,
        installments: form === 'installment' ? Number(installments) : undefined,
        variableAmount: form === 'recurring' ? variable : undefined,
        date,
        dueDate: credit ? undefined : dueDate || undefined,
        method,
        accountId: accountId || undefined,
        categoryId: catId ?? undefined,
        alreadyPaid: credit ? undefined : alreadyPaid,
        note: note.trim() || undefined,
      });
      invalidateFinance(walletId);
      toast(type === 'income' ? 'Entrada adicionada.' : 'Despesa adicionada.');
      onClose();
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  }

  const errFields = (err as { fields?: Record<string, string> } | null)?.fields ?? f;
  return (
    <Modal
      wide
      title={type === 'income' ? 'Adicionar entrada' : 'Adicionar despesa'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" icon="check" onClick={save} busy={busy}>
            Salvar
          </Button>
        </>
      }
    >
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
      <Field label={type === 'income' ? 'Descrição' : 'Serviço'} htmlFor="it-desc" error={errFields.description}>
        <input id="it-desc" className="ff-input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={type === 'income' ? 'Ex.: Salário' : 'Ex.: Conta de luz'} autoFocus />
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
          label={form === 'installment' ? 'Valor total' : form === 'recurring' ? 'Valor do mês' : 'Valor'}
          htmlFor="it-amount"
          error={errFields.amountCents}
          hint={perInstallment ? `${installments}x de cerca de R$ ${(perInstallment / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : undefined}
        >
          <MoneyInput id="it-amount" value={amount} onChange={setAmount} />
        </Field>
        {form === 'installment' ? (
          <Field label="Número de parcelas" htmlFor="it-inst" error={errFields.installments}>
            <input id="it-inst" className="ff-input" inputMode="numeric" value={installments} onChange={(e) => setInstallments(e.target.value.replace(/\D/g, '').slice(0, 3))} />
          </Field>
        ) : (
          <Field label={credit ? 'Data da compra' : 'Data'} htmlFor="it-date" error={errFields.date}>
            <input id="it-date" type="date" className="ff-input ff-num" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        )}
      </div>
      {form === 'installment' && (
        <Field label={credit ? 'Data da compra' : 'Data'} htmlFor="it-date2" error={errFields.date}>
          <input id="it-date2" type="date" className="ff-input ff-num" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      )}
      {form === 'recurring' && (
        <label className="app-checkbox">
          <input type="checkbox" checked={variable} onChange={(e) => setVariable(e.target.checked)} />O valor varia todo mês (luz, água): o próximo mês começa com o último valor {verb}
        </label>
      )}
      <div className="app-grid2">
        <Field label="Método" htmlFor="it-method" error={errFields.method}>
          <select id="it-method" className="ff-select" value={method} onChange={(e) => setMethod(e.target.value as Method)}>
            {methods.map((m) => (
              <option key={m} value={m}>
                {METHOD_LABEL[m]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={credit ? 'Cartão' : 'Banco / conta'} optional={!credit} htmlFor="it-account" error={errFields.accountId}>
          <select id="it-account" className="ff-select" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">{credit ? 'Escolha o cartão' : 'Nenhuma'}</option>
            {accountOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {credit && accountOptions.length === 0 && <Notice tone="danger">Cadastre um cartão em Contas e cartões para lançar no crédito.</Notice>}
      {credit && preview.data && (
        <Notice>
          Vai para a fatura de {formatMonthShort(preview.data.referenceMonth, true)}, que vence em {formatDateBR(preview.data.dueDate)}
          {form === 'installment' ? '. As outras parcelas vão para as faturas seguintes.' : '.'}
        </Notice>
      )}
      {!credit && (
        <Field
          label={form === 'recurring' ? 'Vencimento (o dia vale para todos os meses)' : 'Data p/ pagamento'}
          optional
          htmlFor="it-due"
          hint={form === 'recurring' ? 'Sem data, não há lembrete por email.' : 'Com data, você recebe o lembrete por email.'}
          error={errFields.dueDate}
        >
          <input id="it-due" type="date" className="ff-input ff-num" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
      )}
      <Field label="Categoria" optional htmlFor="it-cat" error={errFields.categoryId}>
        {newCategory === null ? (
          <select
            id="it-cat"
            className="ff-select"
            value={categoryId}
            onChange={(e) => {
              if (e.target.value === '__new') setNewCategory('');
              else setCategoryId(e.target.value);
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
            <input id="it-cat" className="ff-input" placeholder="Nome da nova categoria" value={newCategory} onChange={(e) => setNewCategory(e.target.value)} autoFocus />
            <Button variant="ghost" onClick={() => setNewCategory(null)}>
              Voltar
            </Button>
          </span>
        )}
      </Field>
      {!credit && (
        <Field label={type === 'income' ? 'Já foi recebido?' : 'Já foi pago?'}>
          <Segmented
            label={type === 'income' ? 'Já foi recebido?' : 'Já foi pago?'}
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
      <Field label="Observação" optional htmlFor="it-note">
        <textarea id="it-note" className="ff-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </Field>
      {err && !Object.keys(errFields).length ? <Notice tone="danger">{errorText(err)}</Notice> : null}
    </Modal>
  );
}
