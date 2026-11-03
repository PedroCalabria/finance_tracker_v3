import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Category, ItemType } from '@ff/shared';
import { Button, ConfirmDialog, Field, IconButton, Loading, Modal, Segmented, errorText, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useCategories, walletUrl } from '../lib/queries';

/** Etapa 2 — categorias criadas pela pessoa, separadas entre despesas e entradas. */
export function CategoriesPage({ walletId }: { walletId: string }) {
  const cats = useCategories(walletId);
  const qc = useQueryClient();
  const toast = useToast();
  const [type, setType] = useState<ItemType>('expense');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState<Category | null>(null);
  const [removing, setRemoving] = useState<Category | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['categories', walletId] });

  async function add(e: FormEvent) {
    e.preventDefault();
    setErr('');
    try {
      await api.post(`${walletUrl(walletId)}/categories`, { name, type });
      setName('');
      await refresh();
      toast('Categoria criada.');
    } catch (e2) {
      setErr(errorText(e2));
    }
  }

  const list = (cats.data ?? []).filter((c) => c.type === type);
  return (
    <div className="app-content">
      <div className="app-pagehead">
        <h1 className="app-pagehead__title">Categorias</h1>
        <Segmented
          label="Tipo de categoria"
          value={type}
          onChange={setType}
          options={[
            { value: 'expense', label: 'Despesas' },
            { value: 'income', label: 'Entradas' },
          ]}
        />
      </div>
      <section className="ff-card">
        <header className="ff-card__header">
          <h2 className="ff-card__title">{type === 'expense' ? 'Categorias de despesa' : 'Categorias de entrada'}</h2>
          <span className="ff-caption">{list.length}</span>
        </header>
        {cats.isPending ? (
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
          <Field label="Nova categoria" htmlFor="new-cat" error={err}>
            <input id="new-cat" className="ff-input" value={name} onChange={(e) => setName(e.target.value)} placeholder={type === 'expense' ? 'Ex.: Farmácia' : 'Ex.: Aluguel recebido'} />
          </Field>
          <Button type="submit" variant="primary" icon="plus" disabled={!name.trim()}>
            Adicionar
          </Button>
        </form>
      </section>
      {editing && <RenameModal walletId={walletId} cat={editing} onClose={() => setEditing(null)} onDone={refresh} />}
      {removing && (
        <RemoveCategory
          walletId={walletId}
          cat={removing}
          onClose={() => setRemoving(null)}
          onDone={async (archived) => {
            await refresh();
            toast(archived ? 'Categoria arquivada: os lançamentos antigos continuam com ela.' : 'Categoria removida.');
          }}
        />
      )}
    </div>
  );
}

function RenameModal({ walletId, cat, onClose, onDone }: { walletId: string; cat: Category; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(cat.name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function save() {
    setBusy(true);
    try {
      await api.patch(`${walletUrl(walletId)}/categories/${cat.id}`, { name });
      onDone();
      onClose();
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Renomear categoria"
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
        <input id="cat-name" className="ff-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

function RemoveCategory({ walletId, cat, onClose, onDone }: { walletId: string; cat: Category; onClose: () => void; onDone: (archived: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <ConfirmDialog
      title={`Remover "${cat.name}"?`}
      message="Se houver lançamentos com essa categoria, ela só sai da lista de escolha. Os lançamentos antigos continuam como estão."
      confirmLabel="Remover"
      busy={busy}
      error={err}
      onClose={onClose}
      onConfirm={async () => {
        setBusy(true);
        try {
          const r = await api.del<{ archived: boolean }>(`${walletUrl(walletId)}/categories/${cat.id}`);
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

