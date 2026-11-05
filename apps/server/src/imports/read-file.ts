import { fileTypeFromBuffer } from 'file-type';
import { detectSource, type ImportReader, type ReadResult, type SourceDoc } from '@ff/shared';
import type { AppContext } from '../context';
import { AppError } from '../http/errors';
import { extractPdf } from './pdf-text';

/**
 * Arquivo enviado → documento lido (ADR-0010). Só em memória: o arquivo não é
 * gravado em lugar nenhum. O tipo vem do conteúdo (PDF por `file-type`, OFX pelo
 * cabeçalho). Os logs levam só a origem, a quantidade de linhas e a duração.
 */

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

const unsupported = () => new AppError(400, 'import_unsupported_file', 'Envie o extrato ou a fatura em PDF, ou um arquivo OFX.');
const unknown = () =>
  new AppError(422, 'import_unknown_source', 'Ainda não sabemos ler este documento. Por enquanto: extrato e fatura do Banco do Brasil em PDF, ou OFX.');

/** OFX: "OFXHEADER:100" (SGML) ou "<?xml … <?OFX" / "<OFX>" logo no começo. */
function looksLikeOfx(head: string): boolean {
  return /^\s*(?:\uFEFF)?\s*(?:OFXHEADER|<\?xml[\s\S]{0,200}?<\?OFX|<OFX>)/i.test(head);
}

/** Decodifica o OFX pelo CHARSET do cabeçalho (1252, UTF-8, ASCII) ou pela declaração XML. */
export function decodeOfx(buf: Buffer): string {
  const head = buf.subarray(0, 2048).toString('latin1');
  const charset = /CHARSET:\s*([\w-]+)/i.exec(head)?.[1] ?? /encoding="([\w-]+)"/i.exec(head)?.[1] ?? '';
  const isUtf8 = /^(utf-?8|unicode)$/i.test(charset);
  if (!isUtf8 && charset && charset.toUpperCase() !== 'NONE') return new TextDecoder('windows-1252').decode(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // Sem charset confiável e bytes que não são UTF-8: o padrão dos bancos brasileiros.
    return new TextDecoder('windows-1252').decode(buf);
  }
}

export interface ReadImport {
  reader: ImportReader;
  result: ReadResult;
}

export async function readImportFile(ctx: AppContext, buf: Buffer, password?: string): Promise<ReadImport> {
  const started = Date.now();
  if (buf.length === 0) throw unsupported();
  if (buf.length > MAX_IMPORT_BYTES) throw new AppError(413, 'file_too_large', 'O arquivo passa de 10 MB.');
  const type = await fileTypeFromBuffer(buf);
  let doc: SourceDoc;
  if (type?.mime === 'application/pdf') {
    doc = await extractPdf(buf, password || undefined);
  } else if (!type && looksLikeOfx(buf.subarray(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0, 2048).toString('latin1'))) {
    doc = { kind: 'text', text: decodeOfx(buf) };
  } else {
    throw unsupported();
  }
  const reader = detectSource(doc);
  if (!reader) throw unknown();
  const result = reader.read(doc);
  ctx.log.info({ readerId: reader.id, lines: result.lines.length, warnings: result.warnings.length, ms: Date.now() - started }, 'importação lida');
  return { reader, result };
}
