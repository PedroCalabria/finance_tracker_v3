import { useState } from 'react';
import type { AttachmentRef } from '@ff/shared';
import { Icon } from '../components/Icon';
import { Field, IconButton, errorText } from '../components/ui';
import { api } from '../lib/api';
import { walletUrl } from '../lib/queries';

const MAX_FILES = 5;
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Reduz fotos no navegador antes de enviar (~2000 px, JPEG 80%). HEIC e PDF
 * vão como estão: o servidor converte o HEIC (ADR-0006).
 */
async function shrink(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.8));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch {
    return file;
  }
}

/** Sem o atributo `capture`: o celular oferece câmera ou arquivos (foto ou PDF). */
export function AttachmentPicker({ walletId, value, onChange }: { walletId: string; value: AttachmentRef[]; onChange: (v: AttachmentRef[]) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function add(files: FileList | null) {
    if (!files?.length) return;
    setErr('');
    const list = [...files].slice(0, MAX_FILES - value.length);
    if (files.length > list.length) setErr(`No máximo ${MAX_FILES} comprovantes por pagamento.`);
    setBusy(true);
    const added: AttachmentRef[] = [];
    for (const f of list) {
      try {
        const small = await shrink(f);
        if (small.size > MAX_BYTES) throw new Error();
        added.push(await api.upload<AttachmentRef>(`${walletUrl(walletId)}/attachments`, small));
      } catch (e) {
        setErr(e instanceof Error && e.message ? errorText(e) : `"${f.name}" passa de 10 MB.`);
      }
    }
    onChange([...value, ...added]);
    setBusy(false);
  }
  return (
    <Field label="Comprovantes" optional hint="Foto ou PDF, até 10 MB cada, no máximo 5." error={err}>
      <label className="ff-upload">
        <Icon name="upload" />
        {busy ? 'Enviando…' : 'Tirar foto ou escolher arquivo'}
        <input
          type="file"
          accept="image/*,application/pdf,.heic,.heif"
          multiple
          className="app-sr"
          disabled={busy || value.length >= MAX_FILES}
          onChange={(e) => {
            void add(e.target.files);
            e.target.value = '';
          }}
        />
      </label>
      {value.length > 0 && (
        <ul className="app-files">
          {value.map((a) => (
            <li key={a.id}>
              <Icon name="file" size={14} />
              {a.name}
              <IconButton icon="x" label={`Remover ${a.name}`} onClick={() => onChange(value.filter((x) => x.id !== a.id))} />
            </li>
          ))}
        </ul>
      )}
    </Field>
  );
}
