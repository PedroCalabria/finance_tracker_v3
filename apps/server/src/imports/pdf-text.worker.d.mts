import type { SourceDoc } from '@ff/shared';

export declare const MAX_PAGES: number;
/** Lança Error com `code`: pdf_password_required, pdf_password_incorrect, import_too_many_pages ou import_unsupported_file. */
export declare function extractPdfText(data: Uint8Array, password?: string): Promise<Extract<SourceDoc, { kind: 'pdf' }>>;
