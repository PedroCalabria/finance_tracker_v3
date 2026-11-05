import { Worker } from 'node:worker_threads';
import type { SourceDoc } from '@ff/shared';
import { AppError } from '../http/errors';

/**
 * Extração do PDF numa worker thread (ADR-0010, D1): limite de tempo e de
 * memória, no máximo 2 ao mesmo tempo por processo. Um PDF malicioso ou
 * gigante derruba só a thread, não a API.
 */

export const PDF_TIMEOUT_MS = 20_000;
const MAX_PARALLEL = 2;
const WORKER_URL = new URL('./pdf-text.worker.mjs', import.meta.url);

let running = 0;
const waiting: Array<() => void> = [];
async function acquire(): Promise<void> {
  if (running < MAX_PARALLEL) {
    running++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}
function release(): void {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

const ERRORS: Record<string, () => AppError> = {
  pdf_password_required: () => new AppError(422, 'pdf_password_required', 'Este PDF tem senha. Informe a senha para abrir.'),
  pdf_password_incorrect: () => new AppError(422, 'pdf_password_incorrect', 'Senha incorreta.'),
  import_too_many_pages: () => new AppError(422, 'import_unsupported_file', 'O PDF tem páginas demais para um extrato ou fatura.'),
  import_unsupported_file: () => new AppError(400, 'import_unsupported_file', 'Não conseguimos abrir este PDF. Envie o extrato ou a fatura original, ou um arquivo OFX.'),
};
const timeout = () => new AppError(422, 'import_timeout', 'Não conseguimos ler este arquivo a tempo. Tente de novo ou use o OFX.');

export async function extractPdf(data: Buffer, password: string | undefined, timeoutMs = PDF_TIMEOUT_MS): Promise<SourceDoc> {
  await acquire();
  const worker = new Worker(WORKER_URL, {
    workerData: { role: 'pdf-text' },
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
    stdout: true,
    stderr: true,
  });
  try {
    return await new Promise<SourceDoc>((resolve, reject) => {
      const timer = setTimeout(() => reject(timeout()), timeoutMs);
      worker.once('message', (msg: { ok: true; doc: SourceDoc } | { ok: false; code: string }) => {
        clearTimeout(timer);
        if (msg.ok) resolve(msg.doc);
        else reject((ERRORS[msg.code] ?? ERRORS.import_unsupported_file!)());
      });
      worker.once('error', () => {
        clearTimeout(timer);
        reject(ERRORS.import_unsupported_file!());
      });
      worker.once('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(ERRORS.import_unsupported_file!());
      });
      // Cópia própria dos bytes, transferida (sem cópia extra) para a thread.
      const copy = new Uint8Array(data);
      worker.postMessage({ data: copy, password }, [copy.buffer]);
    });
  } finally {
    await worker.terminate();
    release();
  }
}
