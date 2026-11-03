import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Account, AccountKind } from '@ff/shared';
import { Button, ConfirmDialog, EmptyState, Field, IconButton, Loading, Modal, Notice, Segmented, errorText, fieldErrors, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useAccounts, walletUrl } from '../lib/queries';

/** Etapa 2 — contas e cartões. Cartões têm dia de fechamento e de vencimento padrão (ADR-0005). */
export function AccountsPage({ walletId }: { walletId: string }) {
  const accounts = useAccounts(walletId);
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<Account | 'new' | null>(null);
  const [archiving, setArchiving] = useState<Account | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['accounts', walletId] });

  const cards = (accounts.data ?? []).filter((a) => a.kind === 'credit_card');
  const banks = (accounts.data ?? []).filter((a) => a.kind === 'account');
  const section = (title: string, list: Account[]) => (
    <section className="ff-card">
      <header className="ff-card__header">
        <h2 className="ff-card__title">{title}</h2>
        <span className="ff-caption">{list.length}</span>
      </header>
      {list.map((a) => (
        <div key={a.id} className="app-list-row">
          <span className="ff-invoice__bank" aria-hidden="true">
            {initials(a.bank)}
          </span>
          <div className="app-list-row__main">
            <p style={{ fontWeight: 600 }}>{a.name}</p>
            <p className="ff-caption">{a.kind === 'credit_card' ? `${a.bank} · fecha dia ${a.closingDay} · vence dia ${a.dueDay}` : a.bank}</p>
          </div>
          <IconButton icon="pencil" label={`Editar ${a.name}`} onClick={() => setEditing(a)} />
          <IconButton icon="trash" label={`Arquivar ${a.name}`} onClick={() => setArchiving(a)} />
        </div>
      ))}
    </section>
  );

  return (
    <div className="app-content">
      <div className="app-pagehead">
        <h1 className="app-pagehead__title">Contas e cartões</h1>
        <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
          Adicionar
        </Button>
      </div>
      {accounts.isPending ? (
        <Loading />
      ) : accounts.data?.length === 0 ? (
        <EmptyState title="Nenhuma conta ainda" action={<Button variant="primary" icon="plus" onClick={() => setEditing('new')}>Adicionar conta ou cartão</Button>}>
          Cadastre os bancos e cartões que a família usa para escolher na hora de lançar.
        </EmptyState>
      ) : (
        <>
          {section('Cartões de crédito', cards)}
          {section('Contas', banks)}
        </>
      )}
      {editing && (
        <AccountModal
          walletId={walletId}
          account={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            void refresh();
            toast('Salvo.');
          }}
        />
      )}
      {archiving && (
        <ArchiveAccount
          walletId={walletId}
          account={archiving}
          onClose={() => setArchiving(null)}
          onDone={() => {
            void refresh();
            toast('Arquivado.');
          }}
        />
      )}
    </div>
  );
}

export const initials = (bank: string) =>
  bank
    .split(/\s+/)
    .filter((w) => w.length > 2 || /^[A-Z]{2,}$/.test(w))
    .map((w) => w[0]!.toUpperCase())
    .join('')
    .slice(0, 2) || bank.slice(0, 2).toUpperCase();

function AccountModal({ walletId, account, onClose, onDone }: { walletId: string; account: Account | null; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<AccountKind>(account?.kind ?? 'credit_card');
  const [name, setName] = useState(account?.name ?? '');
  const [bank, setBank] = useState(account?.bank ?? '');
  const [closingDay, setClosingDay] = useState(account?.closingDay?.toString() ?? '');
  const [dueDay, setDueDay] = useState(account?.dueDay?.toString() ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const f = fieldErrors(err);
  async function save() {
    setBusy(true);
    setErr(null);
    const days = kind === 'credit_card' ? { closingDay: Number(closingDay) || undefined, dueDay: Number(dueDay) || undefined } : {};
    try {
      if (account) await api.patch(`${walletUrl(walletId)}/accounts/${account.id}`, { name, bank, ...days });
      else await api.post(`${walletUrl(walletId)}/accounts`, { name, bank, kind, ...days });
      onDone();
      onClose();
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={account ? 'Editar' : 'Nova conta ou cartão'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={save} busy={busy}>
            Salvar
          </Button>
        </>
      }
    >
      {!account && (
        <Field label="Tipo">
          <Segmented
            label="Tipo"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'credit_card', label: 'Cartão de crédito' },
              { value: 'account', label: 'Conta' },
            ]}
          />
        </Field>
      )}
      <Field label="Nome" htmlFor="acc-name" error={f.name} hint={kind === 'credit_card' ? 'Ex.: BB Crédito' : 'Ex.: Conta corrente BB'}>
        <input id="acc-name" className="ff-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <Field label="Banco" htmlFor="acc-bank" error={f.bank}>
        <input id="acc-bank" className="ff-input" value={bank} onChange={(e) => setBank(e.target.value)} list="bancos" />
        <datalist id="bancos">
          {['Banco do Brasil', 'Bradesco', 'XP', 'Nubank', 'Itaú', 'Caixa', 'Santander', 'Inter'].map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
      </Field>
      {kind === 'credit_card' && (
        <>
          <div className="app-grid2">
            <Field label="Dia do fechamento" htmlFor="acc-close" error={f.closingDay}>
              <input id="acc-close" className="ff-input" inputMode="numeric" value={closingDay} onChange={(e) => setClosingDay(e.target.value.replace(/\D/g, '').slice(0, 2))} />
            </Field>
            <Field label="Dia do vencimento" htmlFor="acc-due" error={f.dueDay}>
              <input id="acc-due" className="ff-input" inputMode="numeric" value={dueDay} onChange={(e) => setDueDay(e.target.value.replace(/\D/g, '').slice(0, 2))} />
            </Field>
          </div>
          <Notice>Compras feitas antes do dia do fechamento entram na fatura daquele mês. Se o banco mudar as datas em algum mês, ajuste na própria fatura.</Notice>
        </>
      )}
      {err && !Object.keys(f).length ? <Notice tone="danger">{errorText(err)}</Notice> : null}
    </Modal>
  );
}

function ArchiveAccount({ walletId, account, onClose, onDone }: { walletId: string; account: Account; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <ConfirmDialog
      title={`Arquivar "${account.name}"?`}
      message="Ela sai da lista de escolha. Os lançamentos e faturas antigos continuam como estão."
      confirmLabel="Arquivar"
      busy={busy}
      onClose={onClose}
      onConfirm={async () => {
        setBusy(true);
        await api.del(`${walletUrl(walletId)}/accounts/${account.id}`);
        onDone();
        onClose();
      }}
    />
  );
}
