/**
 * Política de reautenticação do cliente (ADR-0003, ADR-0009), sem `fetch` nem
 * `navigator` aqui dentro para poder ser testada.
 *
 * O cookie `ff_access` vence junto com o JWT, então uma sessão vencida chega
 * como qualquer 401 (em geral `unauthorized`, sem cookie). Em qualquer 401 fora
 * de `/api/auth/`: renova uma vez e repete a requisição uma vez, mesmo se a
 * renovação falhar (outra aba pode já ter renovado os cookies). Só se a
 * repetição também for 401 a sessão é dada como perdida.
 */

/** Resultado de `/api/auth/refresh`. `superseded` = outra aba rotacionou o token há instantes. */
export type RenewOutcome = 'ok' | 'superseded' | 'failed';

/** Espera antes de repetir quando outra aba venceu a corrida: tempo de a resposta dela gravar os cookies. */
export const SUPERSEDED_WAIT_MS = 500;

export const isAuthUrl = (url: string): boolean => url.startsWith('/api/auth/');

export interface SessionRetryDeps<R> {
  /** Envia a requisição original. Falha de rede: lança (e nada mais acontece). */
  send: () => Promise<R>;
  isUnauthorized: (res: R) => boolean;
  /** Renova a sessão. Falha de rede: lança. */
  renew: () => Promise<RenewOutcome>;
  sleep: (ms: number) => Promise<void>;
  onSessionLost: () => void;
}

/**
 * Envia com renovação transparente. Devolve a última resposta; se ela ainda for
 * 401, `onSessionLost` já foi chamado e o chamador transforma a resposta em erro.
 */
export async function sendWithSessionRetry<R>(url: string, deps: SessionRetryDeps<R>): Promise<R> {
  const first = await deps.send();
  if (!deps.isUnauthorized(first) || isAuthUrl(url)) return first;
  const outcome = await deps.renew();
  if (outcome === 'superseded') await deps.sleep(SUPERSEDED_WAIT_MS);
  const second = await deps.send();
  if (deps.isUnauthorized(second)) deps.onSessionLost();
  return second;
}

/**
 * Compartilha uma execução em andamento: quem chamar enquanto ela não terminou
 * recebe a mesma promessa (uma renovação para N chamadas simultâneas).
 */
export function shareInFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  return () => {
    running ??= fn().finally(() => {
      running = null;
    });
    return running;
  };
}
