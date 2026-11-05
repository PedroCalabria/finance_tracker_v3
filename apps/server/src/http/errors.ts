import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError, type ZodTypeAny, type output } from 'zod';

/** Erro de domínio com código estável e mensagem em português para a interface (ADR-0002). */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Registro') => new AppError(404, 'not_found', `${what} não encontrado.`);
/** 409. O código padrão é o de conflito de versão; recusas de regra usam um código próprio e estável. */
export const conflict = (message = 'Isso foi alterado por outra pessoa. Recarregue a página.', code = 'conflict') => new AppError(409, code, message);
export const badRequest = (message: string, fields?: Record<string, string>) => new AppError(400, 'bad_request', message, fields);
export const unauthorized = (message = 'Faça login para continuar.') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Você não tem acesso a isso.') => new AppError(403, 'forbidden', message);

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): output<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw fromZod(r.error);
  return r.data;
}

function fromZod(err: ZodError): AppError {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.message;
  }
  const first = err.issues[0]?.message ?? 'Dados inválidos.';
  return new AppError(400, 'validation', first, fields);
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError | Error, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, fields: err.fields } });
    }
    if (err instanceof ZodError) {
      const e = fromZod(err);
      return reply.status(400).send({ error: { code: e.code, message: e.message, fields: e.fields } });
    }
    const fe = err as FastifyError;
    if (fe.statusCode === 429) {
      return reply.status(429).send({ error: { code: 'rate_limited', message: 'Muitas tentativas. Aguarde um minuto e tente de novo.' } });
    }
    if (fe.statusCode && fe.statusCode < 500) {
      return reply.status(fe.statusCode).send({ error: { code: fe.code ?? 'bad_request', message: 'Requisição inválida.' } });
    }
    req.log.error({ err }, 'erro inesperado');
    return reply.status(500).send({ error: { code: 'internal', message: 'Algo deu errado do nosso lado. Tente de novo.' } });
  });
  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: { code: 'not_found', message: 'Endereço não encontrado.' } });
  });
}
