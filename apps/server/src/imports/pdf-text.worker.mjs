// Extração do texto de um PDF com a posição de cada trecho (ADR-0010, D1).
//
// Arquivo JavaScript de propósito: roda numa worker thread (com limite de tempo e
// de memória, ver pdf-text.ts) em desenvolvimento, nos testes e no build, sem
// depender de carregador de TypeScript. Tipos em pdf-text.worker.d.mts.
//
// `unpdf` traz o pdf.js 6 empacotado: sem eval e sem dependência nativa.
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { getDocumentProxy } from 'unpdf';

export const MAX_PAGES = 50;

const round = (n) => Math.round(n * 10) / 10;

/** @returns {Promise<{ kind: 'pdf', pages: Array<{ width: number, height: number, items: Array<{ x: number, y: number, w: number, text: string }> }> }>} */
export async function extractPdfText(data, password) {
  let doc;
  try {
    doc = await getDocumentProxy(new Uint8Array(data), {
      password,
      // Sem fontes do sistema nem embutidas: só o texto interessa.
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: false,
      verbosity: 0,
    });
  } catch (e) {
    // PasswordResponses do pdf.js: 1 = NEED_PASSWORD, 2 = INCORRECT_PASSWORD.
    if (e && e.name === 'PasswordException') throw Object.assign(new Error('pdf_password'), { code: e.code === 2 ? 'pdf_password_incorrect' : 'pdf_password_required' });
    throw Object.assign(new Error('pdf_invalid'), { code: 'import_unsupported_file' });
  }
  try {
    if (doc.numPages > MAX_PAGES) throw Object.assign(new Error('pdf_too_long'), { code: 'import_too_many_pages' });
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items = [];
      for (const i of tc.items) {
        if (!('str' in i) || !i.str.trim()) continue;
        items.push({ x: round(i.transform[4]), y: round(i.transform[5]), w: round(i.width), text: i.str });
      }
      pages.push({ width: Math.round(vp.width), height: Math.round(vp.height), items });
      page.cleanup();
    }
    return { kind: 'pdf', pages };
  } finally {
    await doc.loadingTask.destroy();
  }
}

// Dentro da thread: lê o PDF recebido e devolve o texto (ou o código do erro).
// A senha chega só pela mensagem e nunca é registrada.
if (!isMainThread && parentPort && workerData?.role === 'pdf-text') {
  parentPort.once('message', async ({ data, password }) => {
    try {
      parentPort.postMessage({ ok: true, doc: await extractPdfText(data, password) });
    } catch (e) {
      parentPort.postMessage({ ok: false, code: (e && e.code) || 'import_unsupported_file' });
    }
  });
}
