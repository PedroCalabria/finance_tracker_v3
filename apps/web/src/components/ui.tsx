import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MONTH_NAMES, centsToInput, formatDateBR, formatMonthShort, parseBRL, type DisplayStatus, type OccurrenceRow, type Person } from '@ff/shared';
import { ApiError } from '../lib/api';
import { todayISO } from '../lib/hooks';
import { Icon, type IconName } from './Icon';

/** Componentes do design system em React (classes ff- de components.css). */

// ---------- Selo de status: sempre ícone + texto
const BADGE: Record<DisplayStatus, { cls: string; icon: IconName; text: string }> = {
  paid: { cls: 'paid', icon: 'check', text: 'Pago' },
  pending: { cls: 'pending', icon: 'clock', text: 'Pendente' },
  partial: { cls: 'partial', icon: 'half', text: 'Parcial' },
  late: { cls: 'late', icon: 'alert', text: 'Atrasado' },
  canceled: { cls: 'neutral', icon: 'ban', text: 'Cancelado' },
  invoice_open: { cls: 'neutral', icon: 'card', text: 'Fatura em aberto' },
  invoice_late: { cls: 'late', icon: 'alert', text: 'Fatura atrasada' },
  invoice_paid: { cls: 'paid', icon: 'check', text: 'Fatura paga' },
  invoice_carried: { cls: 'partial', icon: 'half', text: 'Fatura parcialmente paga' },
};

export function StatusBadge({ status, label }: { status: DisplayStatus; label?: string }) {
  const b = BADGE[status];
  return (
    <span className={`ff-badge ff-badge--${b.cls}`}>
      <Icon name={b.icon} />
      {label ?? b.text}
    </span>
  );
}

/** Texto do selo de uma linha, com detalhes (mês do atraso, quanto falta, receber). */
export function rowBadge(r: OccurrenceRow): { status: DisplayStatus; label?: string } {
  const income = r.type === 'income';
  if (r.displayStatus === 'paid') return { status: 'paid', label: income ? 'Recebido' : 'Pago' };
  if (r.displayStatus === 'late') return { status: 'late', label: `Atrasado (${formatMonthShort(r.competenceMonth)})` };
  if (r.displayStatus === 'partial') return { status: 'partial', label: `Parcial · faltam ${brl(r.remainingCents)}` };
  if (r.displayStatus === 'invoice_paid' && r.invoice) return { status: 'invoice_paid' };
  return { status: r.displayStatus };
}

export const brl = (cents: number) => `R$ ${centsToInput(cents)}`;
export const dateBR = (d: string | null | undefined, short = false) => (d ? formatDateBR(d, short) : '—');

// ---------- Botão
type BtnVariant = 'primary' | 'secondary' | 'ghost';
export function Button({
  variant = 'secondary',
  size,
  icon,
  children,
  busy,
  block,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm'; icon?: IconName; busy?: boolean; block?: boolean }) {
  const cls = ['ff-btn', `ff-btn--${variant}`, size === 'sm' && 'ff-btn--sm', block && 'ff-btn--block', className].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} disabled={busy || rest.disabled} aria-busy={busy || undefined} {...rest}>
      {icon && <Icon name={icon} />}
      {busy ? 'Aguarde…' : children}
    </button>
  );
}

export function IconButton({ icon, label, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return (
    <button type="button" className="ff-icon-btn" aria-label={label} title={label} {...rest}>
      <Icon name={icon} />
    </button>
  );
}

// ---------- Campos
export function Field({ label, optional, hint, error, children, htmlFor }: { label: string; optional?: boolean; hint?: string; error?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className={`ff-field${error ? ' ff-field--error' : ''}`}>
      <label className="ff-field__label" htmlFor={htmlFor}>
        {label} {optional && <small>(opcional)</small>}
      </label>
      {children}
      {error ? (
        <span className="ff-field__error" role="alert">
          <Icon name="alert" />
          {error}
        </span>
      ) : (
        hint && <span className="ff-field__hint">{hint}</span>
      )}
    </div>
  );
}

/** Campo de valor em reais: aceita "1.234,56"; formata ao sair do campo. */
export function MoneyInput({ id, value, onChange, disabled, autoFocus }: { id?: string; value: number | null; onChange: (cents: number | null) => void; disabled?: boolean; autoFocus?: boolean }) {
  const [text, setText] = useState(value != null ? centsToInput(value) : '');
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      setText(value != null ? centsToInput(value) : '');
      last.current = value;
    }
  }, [value]);
  return (
    <span className="ff-money">
      <span aria-hidden="true">R$</span>
      <input
        id={id}
        className="ff-input"
        inputMode="decimal"
        autoComplete="off"
        placeholder="0,00"
        value={text}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(e) => {
          setText(e.target.value);
          const c = parseBRL(e.target.value);
          last.current = c;
          onChange(c);
        }}
        onBlur={() => {
          if (last.current != null) setText(centsToInput(last.current));
        }}
      />
    </span>
  );
}

/**
 * Mês e ano em duas listas (ADR-0009): `<input type="month">` não funciona bem
 * no Safari. O rótulo do Field aponta para a lista do mês (`id`); a do ano tem
 * rótulo próprio. Valor `YYYY-MM`. Anos: 5 para trás e 5 para a frente do atual,
 * sempre incluindo o do valor.
 */
export function MonthInput({ id, value, onChange, label }: { id: string; value: string; onChange: (month: string) => void; label: string }) {
  const thisYear = Number(todayISO().slice(0, 4));
  const year = Number(value.slice(0, 4)) || thisYear;
  const month = value.slice(5, 7) || '01';
  const from = Math.min(year, thisYear - 5);
  const to = Math.max(year, thisYear + 5);
  const years = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  return (
    <span className="app-monthpick" role="group" aria-label={label}>
      <select id={id} className="ff-select" value={month} onChange={(e) => onChange(`${year}-${e.target.value}`)} aria-label={`${label}: mês`}>
        {MONTH_NAMES.map((name, i) => (
          <option key={name} value={String(i + 1).padStart(2, '0')}>
            {name.charAt(0).toUpperCase() + name.slice(1)}
          </option>
        ))}
      </select>
      <select className="ff-select ff-num" value={year} onChange={(e) => onChange(`${e.target.value}-${month}`)} aria-label={`${label}: ano`}>
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
    </span>
  );
}

/** Dia do mês (1–31), só números. Vazio = sem dia. */
export function DayInput({ id, value, onChange }: { id: string; value: number | null; onChange: (day: number | null) => void }) {
  return (
    <input
      id={id}
      className="ff-input ff-num app-day"
      inputMode="numeric"
      autoComplete="off"
      placeholder="Ex.: 10"
      value={value ?? ''}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D/g, '').slice(0, 2);
        onChange(digits ? Number(digits) : null);
      }}
    />
  );
}

/**
 * Número inteiro com setas dentro da caixa (ADR-0009): o design system não tem esse
 * campo, e o `type="number"` não mostra as setas no Safari do iPhone. As setas ficam
 * fora da tabulação; no teclado, ↑/↓ no próprio campo. O valor é texto para a
 * pessoa poder apagar e digitar de novo.
 */
export function StepperInput({
  id,
  value,
  onChange,
  min,
  max,
  incLabel,
  decLabel,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  min: number;
  max: number;
  incLabel: string;
  decLabel: string;
}) {
  const n = value === '' ? null : Number(value);
  const step = (d: 1 | -1) => {
    const next = n == null ? min : Math.min(max, Math.max(min, n + d));
    onChange(String(next));
  };
  const canDec = n != null && n > min;
  const canInc = n == null || n < max;
  return (
    <span className="app-stepper">
      <input
        id={id}
        className="ff-input ff-num"
        inputMode="numeric"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, String(max).length))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' && canInc) (e.preventDefault(), step(1));
          else if (e.key === 'ArrowDown' && canDec) (e.preventDefault(), step(-1));
        }}
      />
      <span className="app-stepper__arrows">
        <button type="button" tabIndex={-1} aria-label={incLabel} title={incLabel} disabled={!canInc} onClick={() => step(1)}>
          <Icon name="up" />
        </button>
        <button type="button" tabIndex={-1} aria-label={decLabel} title={decLabel} disabled={!canDec} onClick={() => step(-1)}>
          <Icon name="down" />
        </button>
      </span>
    </span>
  );
}

/**
 * Responsável do lançamento: "Eu" (valor vazio, opcional), as pessoas ativas em ordem
 * alfabética e "+ Nova pessoa", que troca a lista por um campo de nome (a pessoa é
 * criada ao salvar). `current` mantém na lista a pessoa atual mesmo arquivada.
 */
export function PersonSelect({
  id,
  people,
  value,
  onChange,
  newName,
  onNewName,
  allowMe = true,
  current,
}: {
  id: string;
  people: Person[];
  value: string;
  onChange: (personId: string) => void;
  newName: string | null;
  onNewName: (name: string | null) => void;
  allowMe?: boolean;
  current?: { id: string; name: string } | null;
}) {
  if (newName !== null) {
    return (
      <span style={{ display: 'flex', gap: 8 }}>
        <input id={id} className="ff-input" placeholder="Nome da pessoa" value={newName} onChange={(e) => onNewName(e.target.value)} maxLength={60} autoFocus />
        <Button variant="ghost" onClick={() => onNewName(null)}>
          Voltar
        </Button>
      </span>
    );
  }
  const list = people.filter((p) => !p.archived);
  if (current && !list.some((p) => p.id === current.id)) list.push({ ...current, archived: true });
  list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return (
    <select
      id={id}
      className="ff-select"
      value={value}
      onChange={(e) => {
        if (e.target.value === '__new') onNewName('');
        else onChange(e.target.value);
      }}
    >
      {allowMe ? <option value="">Eu</option> : <option value="">Escolha a pessoa</option>}
      {list.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
      <option value="__new">+ Nova pessoa</option>
    </select>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="ff-tabs" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className="ff-tab" role="radio" aria-checked={value === o.value} aria-selected={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'danger' }) {
  return (
    <div className={`ff-notice${tone === 'danger' ? ' ff-notice--danger' : ''}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={tone === 'danger' ? 'alert' : 'info'} />
      <span>{children}</span>
    </div>
  );
}

export function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Algo deu errado. Tente de novo.';
}
export function fieldErrors(err: unknown): Record<string, string> {
  return err instanceof ApiError ? err.fields : {};
}

// ---------- Modal: foco preso, Esc fecha, devolve o foco a quem abriu
export function Modal({ title, subtitle, onClose, children, footer, wide }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const el = ref.current!;
    const focusables = () => [...el.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled'));
    (el.querySelector<HTMLElement>('[autofocus]') ?? focusables()[1] ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const f = focusables();
        if (f.length === 0) return;
        if (e.shiftKey && document.activeElement === f[0]) {
          e.preventDefault();
          f.at(-1)!.focus();
        } else if (!e.shiftKey && document.activeElement === f.at(-1)) {
          e.preventDefault();
          f[0]!.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      opener?.focus?.();
    };
  }, [onClose]);
  return createPortal(
    <div className="app-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`ff-dialog${wide ? ' app-dialog--wide' : ''}`} tabIndex={-1}>
        <div className="ff-dialog__head">
          <div>
            <h2 id={titleId} className="ff-dialog__title">
              {title}
            </h2>
            {subtitle && <p className="ff-caption app-m0">{subtitle}</p>}
          </div>
          <IconButton icon="x" label="Fechar" onClick={onClose} />
        </div>
        <div className="ff-dialog__body">{children}</div>
        {footer && <div className="ff-dialog__foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onClose, busy, error }: { title: string; message: ReactNode; confirmLabel: string; onConfirm: () => void; onClose: () => void; busy?: boolean; error?: string }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Voltar
          </Button>
          <Button variant="primary" onClick={onConfirm} busy={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="app-m0">{message}</p>
      {error && <Notice tone="danger">{error}</Notice>}
    </Modal>
  );
}

// ---------- Avisos rápidos (toast)
const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msgs, setMsgs] = useState<Array<{ id: number; text: string }>>([]);
  const show = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setMsgs((m) => [...m, { id, text }]);
    setTimeout(() => setMsgs((m) => m.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div className="app-toasts" role="status" aria-live="polite">
        {msgs.map((m) => (
          <div key={m.id} className="app-toast">
            <Icon name="check" />
            {m.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function Loading({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div className="app-loading" role="status">
      {label}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="app-empty">
      <p className="app-empty__title">{title}</p>
      {children && <p className="ff-muted app-m0">{children}</p>}
      {action}
    </div>
  );
}
