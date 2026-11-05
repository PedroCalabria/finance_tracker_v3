import { sendWithSessionRetry, shareInFlight, type ApiErrorBody, type RenewOutcome } from '@ff/shared';

/**
 * Cliente da API (ADR-0009). Os cookies httpOnly viajam sozinhos. Em qualquer
 * 401 fora de /api/auth (o cookie de acesso vence junto com o JWT e o navegador
 * o apaga), renova a sessão uma única vez e repete a chamada uma vez, mesmo se
 * a renovação falhar: outra aba pode já ter renovado (`sendWithSessionRetry`).
 * A renovação é compartilhada entre chamadas simultâneas e, com Web Locks,
 * serializada entre abas. Sem sessão, avisa o app para ir ao login.
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

let onSessionLost: () => void = () => {};
export const setSessionLostHandler = (fn: () => void) => {
  onSessionLost = fn;
};

async function callRefresh(): Promise<RenewOutcome> {
  const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' });
  if (res.ok) return 'ok';
  const err = await toError(res);
  return err.code === 'refresh_superseded' ? 'superseded' : 'failed';
}

/**
 * Uma renovação por vez: na aba (promessa compartilhada) e entre abas (Web
 * Locks, quando o navegador tem). Com o lock, a segunda aba só renova depois que
 * a resposta da primeira gravou os cookies novos, e a corrida não acontece.
 */
const renewSession = shareInFlight(() => {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? locks.request('ff-session-refresh', callRefresh) : callRefresh();
});

const offline = () => new ApiError(0, 'offline', 'Sem conexão com o servidor. Confira sua internet.');

async function toError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
  if (body?.error) return new ApiError(res.status, body.error.code, body.error.message, body.error.fields);
  return new ApiError(res.status, 'network', res.status >= 500 ? 'Algo deu errado do nosso lado. Tente de novo.' : 'Não foi possível completar a ação.');
}

export async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const send = () =>
    fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined || isForm ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
  let res: Response;
  try {
    res = await sendWithSessionRetry(url, {
      send,
      isUnauthorized: (r) => r.status === 401,
      renew: renewSession,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      onSessionLost: () => onSessionLost(),
    });
  } catch {
    throw offline();
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
