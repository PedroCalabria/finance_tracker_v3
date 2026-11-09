import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ItemType } from '@ff/shared';
import { Button, ConfirmDialog, Field, IconButton, Loading, Modal, Segmented, errorText, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useCategories, usePeople, walletUrl } from '../lib/queries';

type Tab = ItemType | 'people';
interface Entry {
  id: string;
  name: string;
}

/** Textos e rota de cada aba: categorias (por tipo) ou pessoas (o responsável dos lançamentos). */
const KIND = {
  category: {
    path: 'categories',
    created: 'Categoria criada.',
    renameTitle: 'Renomear categoria',
    removeMessage: 'Se houver lançamentos com essa categoria, ela só sai da lista de escolha. Os lançamentos antigos continuam como estão.',
    archived: 'Categoria arquivada: os lançamentos antigos continuam com ela.',
    removed: 'Categoria removida.',
  },
  person: {
    path: 'people',
    created: 'Pessoa cadastrada.',
    renameTitle: 'Renomear pessoa',
    removeMessage: 'Se essa pessoa for responsável por algum lançamento, ela só sai da lista de escolha. Os lançamentos antigos continuam com ela.',
    archived: 'Pessoa arquivada: os lançamentos antigos continuam com ela.',
    removed: 'Pessoa removida.',
  },
} as const;
type Kind = (typeof KIND)[keyof typeof KIND];

/** Etapa 2 — categorias criadas pela pessoa, separadas entre despesas e entradas, e as pessoas da carteira. */
export function CategoriesPage({ walletId }: { walletId: string }) {
  const cats = useCategories(walletId);
  const people = usePeople(walletId);
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('expense');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState<Entry | null>(null);
  const [removing, setRemoving] = useState<Entry | null>(null);
  const isPeople = tab === 'people';
  const kind: Kind = isPeople ? KIND.person : KIND.category;
  const refresh = () => qc.invalidateQueries({ queryKey: [isPeople ? 'people' : 'categories', walletId] });

  async function add(e: FormEvent) {
    e.preventDefault();
    setErr('');
    try {
      await api.post(`${walletUrl(walletId)}/${kind.path}`, isPeople ? { name } : { name, type: tab });
      setName('');
      await refresh();
      toast(kind.created);
    } catch (e2) {
      setErr(errorText(e2));
    }
  }

  const list: Entry[] = isPeople ? (people.data ?? []) : (cats.data ?? []).filter((c) => c.type === tab);
  const pending = isPeople ? people.isPending : cats.isPending;
  const title = isPeople ? 'Pessoas' : tab === 'expense' ? 'Categorias de despesa' : 'Categorias de entrada';
  return (
    <div className="app-content">
      <div className="app-pagehead">
        <h1 className="app-pagehead__title">Categorias</h1>
        <Segmented
          label="O que cadastrar"
          value={tab}
          onChange={(t) => {
            setTab(t);
            setErr('');
          }}
          options={[
            { value: 'expense', label: 'Despesas' },
            { value: 'income', label: 'Entradas' },
            { value: 'people', label: 'Pessoas' },
          ]}
        />
      </div>
      <section className="ff-card">
        <header className="ff-card__header">
          <h2 className="ff-card__title">{title}</h2>
          <span className="ff-caption">{list.length}</span>
        </header>
        {isPeople && (
          <p className="ff-caption app-list-row">O responsável de cada despesa ou entrada. Sem pessoa, o lançamento é seu ("Eu").</p>
        )}
        {pending ? (
          <Loading />
        ) : (
          list.map((c) => (
            <div key={c.id} className="app-list-row">
              <div className="app-list-row__main">
                <p>{c.name}</p>
              </div>
              <IconButton icon="pencil" label={`Renomear ${c.name}`} onClick={() => setEditing(c)} />
              <IconButton icon="trash" label={`Remover ${c.name}`} onClick={() => setRemoving(c)} />
            </div>
          ))
        )}
        <form className="app-inline-form" onSubmit={add}>
          <Field label={isPeople ? 'Nova pessoa' : 'Nova categoria'} htmlFor="new-cat" error={err}>
            <input
              id="new-cat"
              className="ff-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              placeholder={isPeople ? 'Ex.: Maria' : tab === 'expense' ? 'Ex.: Farmácia' : 'Ex.: Aluguel recebido'}
            />
          </Field>
          <Button type="submit" variant="primary" icon="plus" disabled={!name.trim()}>
            Adicionar
          </Button>
        </form>
      </section>
      {editing && <RenameModal walletId={walletId} kind={kind} entry={editing} onClose={() => setEditing(null)} onDone={refresh} />}
      {removing && (
        <RemoveEntry
          walletId={walletId}
          kind={kind}
          entry={removing}
          onClose={() => setRemoving(null)}
          onDone={async (archived) => {
            await refresh();
            toast(archived ? kind.archived : kind.removed);
          }}
        />
      )}
    </div>
  );
}

function RenameModal({ walletId, kind, entry, onClose, onDone }: { walletId: string; kind: Kind; entry: Entry; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(entry.name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function save() {
    setBusy(true);
    try {
      await api.patch(`${walletUrl(walletId)}/${kind.path}/${entry.id}`, { name });
      onDone();
      onClose();
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  }
  return (
    <Modal
      title={kind.renameTitle}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={save} busy={busy} disabled={!name.trim()}>
            Salvar
          </Button>
        </>
      }
    >
      <Field label="Nome" htmlFor="cat-name" error={err}>
        <input id="cat-name" className="ff-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />
      </Field>
    </Modal>
  );
}

function RemoveEntry({ walletId, kind, entry, onClose, onDone }: { walletId: string; kind: Kind; entry: Entry; onClose: () => void; onDone: (archived: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <ConfirmDialog
      title={`Remover "${entry.name}"?`}
      message={kind.removeMessage}
      confirmLabel="Remover"
      busy={busy}
      error={err}
      onClose={onClose}
      onConfirm={async () => {
        setBusy(true);
        try {
          const r = await api.del<{ archived: boolean }>(`${walletUrl(walletId)}/${kind.path}/${entry.id}`);
          onDone(r.archived);
          onClose();
        } catch (e) {
          setErr(errorText(e));
          setBusy(false);
        }
      }}
    />
  );
}
