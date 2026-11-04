import type { ApiErrorBody } from '@ff/shared';

/**
 * Cliente da API (ADR-0009). Os cookies httpOnly viajam sozinhos; quando o
 * access token expira, renova uma única vez (mesmo com várias chamadas ao mesmo
 * tempo) e repete a requisição. Sem sessão, avisa o app para ir ao login.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

let refreshing: Promise<boolean> | null = null;
let onSessionLost: () => void = () => {};
export const setSessionLostHandler = (fn: () => void) => {
  onSessionLost = fn;
};

async function refreshSession(): Promise<boolean> {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => setTimeout(() => (refreshing = null), 0));
  return refreshing;
}

async function toError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
  if (body?.error) return new ApiError(res.status, body.error.code, body.error.message, body.error.fields);
  return new ApiError(res.status, 'network', res.status >= 500 ? 'Algo deu errado do nosso lado. Tente de novo.' : 'Não foi possível completar a ação.');
}

export async function request<T>(method: string, url: string, body?: unknown, retry = true): Promise<T> {
  const isForm = body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined || isForm ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'offline', 'Sem conexão com o servidor. Confira sua internet.');
  }
  if (res.status === 401 && retry && !url.startsWith('/api/auth/')) {
    const err = await toError(res.clone());
    if (err.code === 'token_expired' && (await refreshSession())) return request<T>(method, url, body, false);
    onSessionLost();
    throw err;
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {}),
  del: <T = void>(url: string) => request<T>('DELETE', url),
  upload: <T>(url: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<T>('POST', url, fd);
  },
};
