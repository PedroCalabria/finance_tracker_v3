import { bbInvoiceReader } from './readers/bb-invoice';
import { bbStatementReader } from './readers/bb-statement';
import { ofxReader } from './readers/ofx';
import type { ImportReader, SourceDoc } from './types';

/**
 * Catálogo de leitores (ADR-0010). Um banco novo é um arquivo em `readers/`
 * mais uma entrada aqui: detecção, casamento e gravação não mudam.
 */
export const READERS: readonly ImportReader[] = [bbStatementReader, bbInvoiceReader, ofxReader];

/** Primeiro leitor que reconhece o documento pelo conteúdo, ou null. */
export function detectSource(doc: SourceDoc): ImportReader | null {
  return READERS.find((r) => r.detect(doc)) ?? null;
}

export const readerById = (id: string): ImportReader | null => READERS.find((r) => r.id === id) ?? null;

export * from './types';
export * from './text';
export * from './classify';
export * from './match';
export * from './contracts';
