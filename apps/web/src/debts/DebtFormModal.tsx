import { useState } from 'react';
import {
  DEBT_CATEGORIES,
  DEBT_CATEGORY_LABELS,
  DEBT_STRUCTURES,
  DEBT_STRUCTURE_LABELS,
  annualToMonthlyPpm,
  categoryDefaults,
  formatRatePpm,
  parsePercentToPpm,
  type DebtCategory,
  type DebtRow,
  type DebtStructure,
  type MinPaymentKind,
  type Person,
} from '@ff/shared';
import { Button, DayInput, Field, Modal, MoneyInput, Notice, PersonSelect, Segmented, StepperInput, errorText, fieldErrors, useToast } from '../components/ui';
import { api } from '../lib/api';
import { todayISO } from '../lib/hooks';
import { invalidateDebts, queryClient, walletUrl } from '../lib/queries';

const pctText = (ppm: number | null | undefined) => (ppm == null ? '' : formatRatePpm(ppm).replace('%', ''));

/**
 * Cadastro e edição de dívida (ADR-0011). Os campos aparecem conforme a estrutura; a categoria
 * sugere a estrutura e "aceita amortização" enquanto a pessoa não mexeu neles. Taxa ao mês ou ao ano.
 */
export function DebtFormModal({
  walletId,
  debt,
  people,
  manualOrder,
  onClose,
}: {
  walletId: string;
  debt?: DebtRow;
  people: Person[];
  /** Estratégia "Minha ordem": a dívida nova entra no fim, com aviso. */
  manualOrder: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const editing = !!debt;
  const [name, setName] = useState(debt?.name ?? '');
  const [category, setCategory] = useState<DebtCategory>(debt?.category ?? 'personal_loan');
  const [structure, setStructure] = useState<DebtStructure>(debt?.structure ?? 'price');
  const [creditorName, setCreditorName] = useState(debt?.creditorName ?? '');
  const [personId, setPersonId] = useState(debt?.creditorPerson?.id ?? '');
  const [newPerson, setNewPerson] = useState<string | null>(null);
  const [rateUnit, setRateUnit] = useState<'month' | 'year'>('month');
  const [rateText, setRateText] = useState(pctText(debt?.monthlyRatePpm));
  const [installment, setInstallment] = useState<number | null>(debt?.installmentCents ?? null);
  const [remaining, setRemaining] = useState(debt?.remainingInstallments != null ? String(debt.remainingInstallments) : '');
  const [dueDay, setDueDay] = useState<number | null>(debt?.dueDay ?? null);
  const [minKind, setMinKind] = useState<MinPaymentKind>(debt?.minPaymentKind ?? 'percent');
  const [minFixed, setMinFixed] = useState<number | null>(debt?.minPaymentKind === 'fixed' ? debt.minPaymentValue : null);
  const [minPct, setMinPct] = useState(debt?.minPaymentKind === 'percent' ? pctText(debt.minPaymentValue) : '');
  const [acceptsExtra, setAcceptsExtra] = useState(debt?.acceptsExtra ?? true);
  const [anchorDate, setAnchorDate] = useState(todayISO());
  const [anchorBalance, setAnchorBalance] = useState<number | null>(null);
  // Padrões da categoria só enquanto a pessoa não escolheu à mão.
  const [touched, setTouched] = useState({ structure: editing, acceptsExtra: editing });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const isPerson = category === 'person';
  const contract = structure === 'price' || structure === 'sac';
  const enteredPpm = parsePercentToPpm(rateText);
  const monthlyPpm = structure === 'interest_free' ? 0 : enteredPpm == null ? null : rateUnit === 'year' ? annualToMonthlyPpm(enteredPpm / 1e6) : enteredPpm;

  function chooseCategory(c: DebtCategory) {
    setCategory(c);
    const d = categoryDefaults(c);
    if (!touched.structure) setStructure(d.structure);
    if (!touched.acceptsExtra) setAcceptsExtra(d.acceptsExtra);
  }

  async function save() {
    setErr(null);
    if (monthlyPpm == null) return setErr(new Error('Informe a taxa (use 0 se não tem juros).'));
    if (!editing && anchorBalance == null) return setErr(new Error('Informe o saldo devedor.'));
    setBusy(true);
    try {
      let creditorPersonId: string | null = isPerson ? personId || null : null;
      if (isPerson && newPerson !== null) {
        if (!newPerson.trim()) throw new Error('Informe o nome da pessoa.');
        creditorPersonId = (await api.post<Person>(`${walletUrl(walletId)}/people`, { name: newPerson })).id;
        setNewPerson(null);
        setPersonId(creditorPersonId);
        void queryClient.invalidateQueries({ queryKey: ['people', walletId] });
      }
      const body = {
        name,
        category,
        structure,
        creditorName: isPerson ? null : creditorName.trim() || null,
        creditorPersonId,
        monthlyRatePpm: monthlyPpm,
        installmentCents: structure === 'price' || structure === 'interest_free' ? installment : null,
        remainingInstallments: contract && remaining ? Number(remaining) : null,
        dueDay: structure === 'revolving' ? null : dueDay,
        minPaymentKind: structure === 'revolving' ? minKind : null,
        minPaymentValue: structure === 'revolving' ? (minKind === 'fixed' ? minFixed : parsePercentToPpm(minPct)) : null,
        acceptsExtra,
      };
      if (editing) {
        await api.put(`${walletUrl(walletId)}/debts/${debt.id}`, { ...body, version: debt.version });
        toast('Dívida atualizada.');
      } else {
        await api.post(`${walletUrl(walletId)}/debts`, { ...body, anchorDate, anchorBalanceCents: anchorBalance ?? 0 });
        toast(manualOrder ? 'Dívida cadastrada. Ela entrou no fim da sua ordem.' : 'Dívida cadastrada.');
      }
      invalidateDebts(walletId);
      onClose();
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  }

  const f = fieldErrors(err);
  return (
    <Modal
      wide
      title={editing ? 'Editar dívida' : 'Nova dívida'}
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
      <div className="app-form">
        <Field label="Nome" htmlFor="debt-name" error={f.name}>
          <input id="debt-name" className="ff-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Empréstimo do banco" autoFocus />
        </Field>
        <div className="app-grid2">
          <Field label="Categoria" htmlFor="debt-category" error={f.category}>
            <select id="debt-category" className="ff-select" value={category} onChange={(e) => chooseCategory(e.target.value as DebtCategory)}>
              {DEBT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {DEBT_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </Field>
          {isPerson ? (
            <Field label="Pessoa" htmlFor="debt-person" error={f.creditorPersonId}>
              <PersonSelect id="debt-person" people={people} value={personId} onChange={setPersonId} newName={newPerson} onNewName={setNewPerson} allowMe={false} current={debt?.creditorPerson} />
            </Field>
          ) : (
            <Field label="Credor" optional htmlFor="debt-creditor" error={f.creditorName}>
              <input id="debt-creditor" className="ff-input" value={creditorName} maxLength={60} onChange={(e) => setCreditorName(e.target.value)} placeholder="Ex.: Banco X" />
            </Field>
          )}
        </div>

        <Field label="Estrutura" htmlFor="debt-structure" error={f.structure} hint={structureHint(structure)}>
          <select
            id="debt-structure"
            className="ff-select"
            value={structure}
            onChange={(e) => {
              setStructure(e.target.value as DebtStructure);
              setTouched((t) => ({ ...t, structure: true }));
            }}
          >
            {DEBT_STRUCTURES.map((s) => (
              <option key={s} value={s}>
                {DEBT_STRUCTURE_LABELS[s]}
              </option>
            ))}
          </select>
        </Field>
        {category === 'card_installment' && structure === 'revolving' && (
          <Notice>O rotativo do cartão só pode durar até a fatura seguinte; depois o banco oferece um parcelamento. Se você já parcelou, cadastre como Price.</Notice>
        )}

        {structure !== 'interest_free' && (
          <Field
            label="Taxa de juros"
            htmlFor="debt-rate"
            error={f.monthlyRatePpm}
            hint={[
              rateUnit === 'year' && monthlyPpm != null ? `Equivale a ${formatRatePpm(monthlyPpm)} ao mês.` : null,
              'Use o CET do contrato, se tiver.',
              category === 'mortgage' ? 'Se o contrato tem TR ou IPCA, some uma estimativa do índice à taxa.' : null,
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <span className="app-rate">
              <span className="ff-money">
                <input id="debt-rate" className="ff-input" inputMode="decimal" autoComplete="off" placeholder="0,00" value={rateText} onChange={(e) => setRateText(e.target.value)} />
                <span aria-hidden="true">%</span>
              </span>
              <Segmented
                label="Período da taxa"
                value={rateUnit}
                onChange={setRateUnit}
                options={[
                  { value: 'month', label: 'ao mês' },
                  { value: 'year', label: 'ao ano' },
                ]}
              />
            </span>
          </Field>
        )}

        {(structure === 'price' || structure === 'interest_free') && (
          <div className="app-grid2">
            <Field label="Parcela atual" optional={structure === 'interest_free'} htmlFor="debt-installment" error={f.installmentCents}>
              <MoneyInput id="debt-installment" value={installment} onChange={setInstallment} />
            </Field>
            <Field label="Dia de vencimento" optional={structure === 'interest_free'} htmlFor="debt-day" error={f.dueDay}>
              <DayInput id="debt-day" value={dueDay} onChange={setDueDay} />
            </Field>
          </div>
        )}
        {contract && (
          <div className="app-grid2">
            <Field label="Parcelas restantes" htmlFor="debt-remaining" error={f.remainingInstallments}>
              <StepperInput id="debt-remaining" value={remaining} onChange={setRemaining} min={1} max={600} incLabel="Mais uma parcela" decLabel="Menos uma parcela" />
            </Field>
            {structure === 'sac' && (
              <Field label="Dia de vencimento" htmlFor="debt-day" error={f.dueDay}>
                <DayInput id="debt-day" value={dueDay} onChange={setDueDay} />
              </Field>
            )}
          </div>
        )}
        {structure === 'revolving' && (
          <Field label="Pagamento mínimo" htmlFor="debt-min" error={f.minPaymentValue ?? f.minPaymentKind}>
            <span className="app-rate">
              {minKind === 'fixed' ? (
                <MoneyInput id="debt-min" value={minFixed} onChange={setMinFixed} />
              ) : (
                <span className="ff-money">
                  <input id="debt-min" className="ff-input" inputMode="decimal" autoComplete="off" placeholder="15" value={minPct} onChange={(e) => setMinPct(e.target.value)} />
                  <span aria-hidden="true">% do saldo</span>
                </span>
              )}
              <Segmented
                label="Tipo do mínimo"
                value={minKind}
                onChange={setMinKind}
                options={[
                  { value: 'percent', label: '% do saldo' },
                  { value: 'fixed', label: 'Valor fixo' },
                ]}
              />
            </span>
          </Field>
        )}

        <label className="app-checkbox">
          <input
            type="checkbox"
            checked={acceptsExtra}
            onChange={(e) => {
              setAcceptsExtra(e.target.checked);
              setTouched((t) => ({ ...t, acceptsExtra: true }));
            }}
          />
          Aceita amortização extra (pagar a mais para reduzir a dívida)
        </label>

        {!editing && (
          <fieldset className="app-subform">
            <legend className="app-subform__title">Saldo devedor</legend>
            <div className="app-grid2">
              <Field label="Saldo de hoje (ou de uma data)" htmlFor="debt-balance" error={f.anchorBalanceCents} hint="Veja no app do banco ou no contrato.">
                <MoneyInput id="debt-balance" value={anchorBalance} onChange={setAnchorBalance} />
              </Field>
              <Field label="Data do saldo" htmlFor="debt-anchor-date" error={f.anchorDate}>
                <input id="debt-anchor-date" type="date" className="ff-input ff-num" value={anchorDate} max={todayISO()} onChange={(e) => setAnchorDate(e.target.value)} />
              </Field>
            </div>
          </fieldset>
        )}
        {editing && contract && <p className="ff-caption app-m0">Mudar a parcela ou as parcelas restantes vale a partir de hoje.</p>}

        {err && !Object.keys(f).length ? <Notice tone="danger">{errorText(err)}</Notice> : null}
      </div>
    </Modal>
  );
}

function structureHint(s: DebtStructure): string {
  switch (s) {
    case 'price':
      return 'Parcela igual todo mês (empréstimos, financiamento de veículo, parcelamento de fatura).';
    case 'sac':
      return 'A parcela cai com o tempo (comum no financiamento imobiliário).';
    case 'revolving':
      return 'Sem parcela: juros sobre o saldo e um pagamento mínimo (cheque especial).';
    case 'interest_free':
      return 'O saldo não cresce (dívida com uma pessoa, parcelado sem juros).';
  }
}
