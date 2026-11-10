import { useState } from 'react';
import {
  INVESTMENT_KINDS,
  INVESTMENT_KIND_LABELS,
  KIND_DEFAULTS,
  TAX_MODE_LABELS,
  addMonths,
  monthOf,
  parsePercentToPpm,
  type InvestmentIcon,
  type InvestmentKind,
  type InvestmentRow,
  type TaxMode,
  type YieldKind,
} from '@ff/shared';
import { Icon } from '../components/Icon';
import { Button, Field, Modal, MoneyInput, MonthInput, Notice, Segmented, errorText, fieldErrors, useToast } from '../components/ui';
import { api } from '../lib/api';
import { todayISO } from '../lib/hooks';
import { invalidateInvestments, walletUrl } from '../lib/queries';
import { ICON_CHOICES, ICON_LABELS, bpToInput, cdiShareInputToBp, ppmToInput, rateInputToMonthlyPpm } from './format';

type Touched = Partial<Record<'yield' | 'tax', boolean>>;

/**
 * Cadastro e edição de caixinha (ADR-0012): uma tela só, em seções, com linguagem simples. O tipo sugere como
 * rende e o imposto enquanto a pessoa não mexe neles. Meta, guardar por mês, trava e imposto ficam em
 * "Mais opções". Sem CDI na carteira, o formulário pede o CDI antes de salvar uma caixinha de % do CDI.
 */
export function InvestmentFormModal({ walletId, inv, cdiAnnualPpm, onClose }: { walletId: string; inv?: InvestmentRow; cdiAnnualPpm: number | null; onClose: () => void }) {
  const toast = useToast();
  const editing = !!inv;
  const today = todayISO();
  const [name, setName] = useState(inv?.name ?? '');
  const [icon, setIcon] = useState<InvestmentIcon>(inv?.icon ?? 'piggy');
  const [kind, setKind] = useState<InvestmentKind>(inv?.kind ?? 'savings_box');
  const start = inv ?? { ...KIND_DEFAULTS.savings_box };
  const [yieldKind, setYieldKind] = useState<YieldKind>(start.yieldKind);
  const [rateText, setRateText] = useState(start.fixedRatePpm != null ? ppmToInput(start.fixedRatePpm) : '');
  const [rateUnit, setRateUnit] = useState<'month' | 'year'>('month');
  const [cdiText, setCdiText] = useState(start.cdiShareBp != null ? bpToInput(start.cdiShareBp) : '100');
  const [taxMode, setTaxMode] = useState<TaxMode>(inv?.taxMode ?? KIND_DEFAULTS.savings_box.taxMode);
  const [touched, setTouched] = useState<Touched>(editing ? { yield: true, tax: true } : {});
  const [initialCents, setInitialCents] = useState<number | null>(null);
  const [initialDate, setInitialDate] = useState(today);
  const [goalCents, setGoalCents] = useState<number | null>(inv?.goalCents ?? null);
  const [hasGoalMonth, setHasGoalMonth] = useState(!!inv?.goalMonth);
  const [goalMonth, setGoalMonth] = useState(inv?.goalMonth ?? addMonths(monthOf(today), 12));
  const [plan, setPlan] = useState<number | null>(inv?.monthlyPlanCents ?? null);
  const [locked, setLocked] = useState(!!inv?.redeemableFrom);
  const [redeemableFrom, setRedeemableFrom] = useState(inv?.redeemableFrom ?? '');
  const [cdiAnnualText, setCdiAnnualText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const needsCdi = yieldKind === 'cdi' && cdiAnnualPpm === null;
  const moreOpen = editing || goalCents != null || plan != null || locked;

  function changeKind(k: InvestmentKind) {
    setKind(k);
    const d = KIND_DEFAULTS[k];
    if (!touched.yield) {
      setYieldKind(d.yieldKind);
      setRateText(d.fixedRatePpm != null ? ppmToInput(d.fixedRatePpm) : '');
      setRateUnit('month');
      setCdiText(d.cdiShareBp != null ? bpToInput(d.cdiShareBp) : '100');
    }
    if (!touched.tax) setTaxMode(d.taxMode);
  }
  const touch = (k: keyof Touched) => setTouched((t) => ({ ...t, [k]: true }));

  async function save() {
    setErr(null);
    if (!name.trim()) return setErr(new Error('Informe o nome da caixinha.'));
    const fixedRatePpm = yieldKind === 'fixed' ? rateInputToMonthlyPpm(rateText, rateUnit) : null;
    const cdiShareBp = yieldKind === 'cdi' ? cdiShareInputToBp(cdiText) : null;
    if (yieldKind === 'fixed' && fixedRatePpm === null) return setErr(new Error('Informe quanto rende (por exemplo, 1,1).'));
    if (yieldKind === 'cdi' && !cdiShareBp) return setErr(new Error('Informe o % do CDI (por exemplo, 100).'));
    if (!editing && !initialCents) return setErr(new Error('Informe quanto você já tem guardado aqui.'));
    if (locked && !redeemableFrom) return setErr(new Error('Informe a partir de quando pode resgatar.'));
    const body = {
      name: name.trim(),
      icon,
      kind,
      yieldKind,
      fixedRatePpm,
      cdiShareBp,
      taxMode,
      goalCents,
      goalMonth: goalCents != null && hasGoalMonth ? goalMonth : null,
      monthlyPlanCents: plan || null,
      redeemableFrom: locked ? redeemableFrom : null,
    };
    setBusy(true);
    try {
      if (needsCdi) {
        const cdi = parsePercentToPpm(cdiAnnualText);
        if (!cdi) throw new Error('Informe o CDI atual (por exemplo, 14,9).');
        await api.put(`${walletUrl(walletId)}/investment-settings`, { cdiAnnualPpm: cdi });
      }
      if (inv) {
        await api.put(`${walletUrl(walletId)}/investments/${inv.id}`, { ...body, version: inv.version });
        toast('Caixinha atualizada.');
      } else {
        await api.post(`${walletUrl(walletId)}/investments`, { ...body, initialCents, initialDate });
        toast('Caixinha criada.');
      }
      invalidateInvestments(walletId);
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
      title={editing ? 'Editar caixinha' : 'Nova caixinha'}
      subtitle="Separe o dinheiro por objetivo e acompanhe quanto rende."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" icon="check" onClick={save} busy={busy}>
            {editing ? 'Salvar' : 'Criar caixinha'}
          </Button>
        </>
      }
    >
      <div className="app-form">
        <Field label="Nome" htmlFor="inv-name" error={f.name} hint="Por exemplo: Reserva de emergência, Viagem.">
          <input id="inv-name" className="ff-input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>

        <fieldset className="app-fieldset">
          <legend className="ff-field__label">Ícone</legend>
          <div className="app-iconpick" role="radiogroup" aria-label="Ícone da caixinha">
            {ICON_CHOICES.map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={icon === k}
                aria-label={ICON_LABELS[k as InvestmentIcon]}
                title={ICON_LABELS[k as InvestmentIcon]}
                className="app-iconpick__item"
                onClick={() => setIcon(k as InvestmentIcon)}
              >
                <Icon name={k} />
              </button>
            ))}
          </div>
          {f.icon && <span className="ff-field__error">{f.icon}</span>}
        </fieldset>

        <Field label="Tipo" htmlFor="inv-kind" hint="O tipo já sugere como rende e o imposto; você pode mudar.">
          <select id="inv-kind" className="ff-select" value={kind} onChange={(e) => changeKind(e.target.value as InvestmentKind)}>
            {INVESTMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {INVESTMENT_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </Field>

        {!editing && (
          <div className="app-grid2">
            <Field label="Quanto você já tem guardado aqui?" htmlFor="inv-initial" error={f.initialCents}>
              <MoneyInput id="inv-initial" value={initialCents} onChange={setInitialCents} />
            </Field>
            <Field label="Desde quando?" htmlFor="inv-initial-date" error={f.initialDate} hint="A data do primeiro aporte. Ela conta para o imposto.">
              <input id="inv-initial-date" type="date" className="ff-input ff-num" value={initialDate} max={today} onChange={(e) => setInitialDate(e.target.value)} />
            </Field>
          </div>
        )}

        <Field label="Rende quanto?" htmlFor="inv-yield" error={f.fixedRatePpm ?? f.cdiShareBp}>
          <div className="app-form app-form--tight">
            <Segmented
              label="Como rende"
              value={yieldKind}
              onChange={(v) => {
                touch('yield');
                setYieldKind(v);
              }}
              options={[
                { value: 'cdi', label: '% do CDI' },
                { value: 'fixed', label: 'Taxa fixa' },
                { value: 'none', label: 'Não rende' },
              ]}
            />
            {yieldKind === 'cdi' && (
              <span className="ff-money">
                <input
                  id="inv-yield"
                  className="ff-input"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="100"
                  value={cdiText}
                  onChange={(e) => {
                    touch('yield');
                    setCdiText(e.target.value);
                  }}
                />
                <span aria-hidden="true">% do CDI</span>
              </span>
            )}
            {yieldKind === 'fixed' && (
              <span className="app-rate">
                <span className="ff-money">
                  <input
                    id="inv-yield"
                    className="ff-input"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="1,0"
                    value={rateText}
                    onChange={(e) => {
                      touch('yield');
                      setRateText(e.target.value);
                    }}
                  />
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
            )}
          </div>
        </Field>

        {needsCdi && (
          <Field label="CDI atual (ao ano)" htmlFor="inv-cdi" hint="Usado para estimar o rendimento de todas as caixinhas. Você pode atualizar depois.">
            <span className="ff-money">
              <input id="inv-cdi" className="ff-input" inputMode="decimal" autoComplete="off" placeholder="14,9" value={cdiAnnualText} onChange={(e) => setCdiAnnualText(e.target.value)} />
              <span aria-hidden="true">% a.a.</span>
            </span>
          </Field>
        )}

        <details className="app-more" open={moreOpen}>
          <summary className="app-section-title">Mais opções</summary>
          <div className="app-form">
            <div className="app-grid2">
              <Field label="Meta" optional htmlFor="inv-goal" error={f.goalCents} hint="Quanto você quer juntar.">
                <MoneyInput id="inv-goal" value={goalCents} onChange={setGoalCents} />
              </Field>
              <Field label="Guardar por mês" optional htmlFor="inv-plan" error={f.monthlyPlanCents} hint="Entra no balanço do mês como dinheiro com destino.">
                <MoneyInput id="inv-plan" value={plan} onChange={setPlan} />
              </Field>
            </div>
            {goalCents != null && (
              <label className="app-checkbox">
                <input type="checkbox" checked={hasGoalMonth} onChange={(e) => setHasGoalMonth(e.target.checked)} />
                Quero chegar na meta até um mês
              </label>
            )}
            {goalCents != null && hasGoalMonth && (
              <Field label="Mês da meta" htmlFor="inv-goal-month" error={f.goalMonth}>
                <MonthInput id="inv-goal-month" label="Mês da meta" value={goalMonth} onChange={setGoalMonth} />
              </Field>
            )}
            <label className="app-checkbox">
              <input type="checkbox" checked={locked} onChange={(e) => setLocked(e.target.checked)} />
              Só pode resgatar a partir de uma data
            </label>
            {locked && (
              <Field label="Resgate a partir de" htmlFor="inv-lock" error={f.redeemableFrom}>
                <input id="inv-lock" type="date" className="ff-input ff-num" value={redeemableFrom} onChange={(e) => setRedeemableFrom(e.target.value)} />
              </Field>
            )}
            <Field label="Imposto" htmlFor="inv-tax" hint="LCI, LCA e poupança são isentas para pessoa física.">
              <Segmented
                label="Imposto"
                value={taxMode}
                onChange={(v) => {
                  touch('tax');
                  setTaxMode(v);
                }}
                options={[
                  { value: 'regressive', label: TAX_MODE_LABELS.regressive },
                  { value: 'exempt', label: TAX_MODE_LABELS.exempt },
                ]}
              />
            </Field>
          </div>
        </details>

        {err && !Object.keys(f).length ? <Notice tone="danger">{errorText(err)}</Notice> : null}
      </div>
    </Modal>
  );
}
