import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  accountInput,
  accountUpdate,
  categoryInput,
  categoryUpdate,
  importConfirmInput,
  importSuggestInput,
  invoicePaymentInput,
  invoiceUpdateInput,
  isoDate,
  itemCreateInput,
  itemEndInput,
  itemEditInput,
  itemUpdateInput,
  month,
  moveInvoiceInput,
  occurrenceUpdateInput,
  occurrencesQuery,
  paymentInput,
  paymentUpdateInput,
  personInput,
  personUpdate,
} from '@ff/shared';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { users } from '../../db/schema';
import * as attachmentsSvc from '../../domain/attachments';
import * as catalog from '../../domain/catalog';
import { clockAt, type Clock } from '../../domain/clock';
import * as invoicesSvc from '../../domain/invoices';
import * as itemsSvc from '../../domain/items';
import * as importConfirmSvc from '../../domain/imports/confirm';
import * as importSuggestSvc from '../../domain/imports/suggest';
import { MAX_IMPORT_BYTES } from '../../imports/read-file';
import * as occSvc from '../../domain/occurrences';
import * as paymentsSvc from '../../domain/payments';
import * as summarySvc from '../../domain/summary';
import { makeRequireUser, makeRequireWallet } from '../auth-plugin';
import { AppError, badRequest, notFound, parse } from '../errors';

/** Rotas de uma carteira: tudo sob /api/wallets/:walletId (ADR-0002). */
export async function walletRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const requireUser = makeRequireUser(ctx);
  const requireWallet = makeRequireWallet(ctx);
  const tzCache = new Map<string, { tz: string; at: number }>();

  async function clock(req: FastifyRequest): Promise<Clock> {
    const hit = tzCache.get(req.userId);
    let tz = hit && Date.now() - hit.at < 60_000 ? hit.tz : undefined;
    if (!tz) {
      const u = await ctx.db.query.users.findFirst({ where: eq(users.id, req.userId), columns: { timezone: true } });
      tz = u?.timezone ?? 'America/Sao_Paulo';
      tzCache.set(req.userId, { tz, at: Date.now() });
    }
    return clockAt(tz, ctx.now());
  }

  const W = '/api/wallets/:walletId';
  type P<T extends string = never> = { Params: { walletId: string } & Record<T, string> };

  await app.register(async (r) => {
    r.addHook('preHandler', requireUser);
    r.addHook('preHandler', requireWallet);

    // ---- Categorias
    r.get<P>(`${W}/categories`, async (req) => catalog.listCategories(ctx.db, req.walletId, (req.query as { all?: string }).all === '1'));
    r.post<P>(`${W}/categories`, async (req, reply) => reply.status(201).send(await catalog.createCategory(ctx.db, req.walletId, parse(categoryInput, req.body))));
    r.patch<P<'id'>>(`${W}/categories/:id`, async (req) => catalog.renameCategory(ctx.db, req.walletId, req.params.id, parse(categoryUpdate, req.body).name));
    r.delete<P<'id'>>(`${W}/categories/:id`, async (req) => catalog.removeCategory(ctx.db, req.walletId, req.params.id));

    // ---- Pessoas (responsável dos lançamentos)
    r.get<P>(`${W}/people`, async (req) => catalog.listPeople(ctx.db, req.walletId, (req.query as { all?: string }).all === '1'));
    r.post<P>(`${W}/people`, async (req, reply) => reply.status(201).send(await catalog.createPerson(ctx.db, req.walletId, parse(personInput, req.body).name)));
    r.patch<P<'id'>>(`${W}/people/:id`, async (req) => catalog.renamePerson(ctx.db, req.walletId, req.params.id, parse(personUpdate, req.body).name));
    r.delete<P<'id'>>(`${W}/people/:id`, async (req) => catalog.removePerson(ctx.db, req.walletId, req.params.id));

    // ---- Contas e cartões
    r.get<P>(`${W}/accounts`, async (req) => catalog.listAccounts(ctx.db, req.walletId, (req.query as { all?: string }).all === '1'));
    r.post<P>(`${W}/accounts`, async (req, reply) => reply.status(201).send(await catalog.createAccount(ctx.db, req.walletId, parse(accountInput, req.body))));
    r.patch<P<'id'>>(`${W}/accounts/:id`, async (req) => catalog.updateAccount(ctx.db, req.walletId, req.params.id, parse(accountUpdate, req.body)));
    r.delete<P<'id'>>(`${W}/accounts/:id`, async (req, reply) => {
      await catalog.archiveAccount(ctx.db, req.walletId, req.params.id);
      return reply.status(204).send();
    });

    // ---- Itens (a regra)
    r.post<P>(`${W}/items`, async (req, reply) =>
      reply.status(201).send(await itemsSvc.createItem(ctx.db, req.walletId, parse(itemCreateInput, req.body), req.userId, await clock(req))),
    );
    r.get<P<'id'>>(`${W}/items/:id`, async (req) => itemsSvc.getItemDetail(ctx.db, req.walletId, req.params.id, await clock(req)));
    r.patch<P<'id'>>(`${W}/items/:id`, async (req) => itemsSvc.updateItem(ctx.db, req.walletId, req.params.id, parse(itemUpdateInput, req.body), await clock(req)));
    r.put<P<'id'>>(`${W}/items/:id`, async (req) => itemsSvc.editItem(ctx.db, req.walletId, req.params.id, parse(itemEditInput, req.body), await clock(req)));
    // "Este e os próximos": encerra antes da ocorrência escolhida; na primeira, exclui tudo (204).
    r.post<P<'id'>>(`${W}/items/:id/end`, async (req, reply) => {
      const detail = await itemsSvc.endRecurringFrom(ctx.db, req.walletId, req.params.id, parse(itemEndInput, req.body).occurrenceId, await clock(req));
      return detail ? reply.send(detail) : reply.status(204).send();
    });
    r.post<P<'id'>>(`${W}/items/:id/cancel`, async (req) => itemsSvc.cancelInstallments(ctx.db, req.walletId, req.params.id, await clock(req)));
    r.delete<P<'id'>>(`${W}/items/:id`, async (req, reply) => {
      const withReimbursement = (req.query as { withReimbursement?: string }).withReimbursement === '1';
      await itemsSvc.deleteItem(ctx.db, req.walletId, req.params.id, { withReimbursement });
      return reply.status(204).send();
    });

    // ---- Ocorrências (as linhas da tabela)
    r.get<P>(`${W}/occurrences`, async (req) => occSvc.listOccurrences(ctx.db, req.walletId, parse(occurrencesQuery, req.query), await clock(req)));
    r.patch<P<'id'>>(`${W}/occurrences/:id`, async (req) =>
      occSvc.updateOccurrence(ctx.db, req.walletId, req.params.id, parse(occurrenceUpdateInput, req.body), await clock(req)),
    );
    // "Só este mês" de uma recorrente (aceita projeção p_<itemId>_<mês>).
    r.post<P<'id'>>(`${W}/occurrences/:id/cancel`, async (req) => occSvc.cancelRecurringMonth(ctx.db, req.walletId, req.params.id, await clock(req)));
    r.post<P<'id'>>(`${W}/occurrences/:id/payments`, async (req, reply) =>
      reply.status(201).send(await paymentsSvc.addPayment(ctx.db, req.walletId, req.params.id, parse(paymentInput, req.body), req.userId, await clock(req))),
    );
    r.delete<P<'id'>>(`${W}/occurrences/:id/payments`, async (req) => paymentsSvc.clearPayments(ctx.db, req.walletId, req.params.id, await clock(req)));
    r.patch<P<'id'>>(`${W}/occurrences/:id/invoice`, async (req) => {
      const { referenceMonth } = parse(moveInvoiceInput, req.body);
      const c = await clock(req);
      await ctx.db.transaction((tx) => invoicesSvc.moveToInvoice(tx, req.walletId, req.params.id, referenceMonth));
      return occSvc.getRow(ctx.db, req.walletId, req.params.id, c);
    });

    // ---- Pagamentos
    r.patch<P<'id'>>(`${W}/payments/:id`, async (req) => paymentsSvc.updatePayment(ctx.db, req.walletId, req.params.id, parse(paymentUpdateInput, req.body), await clock(req)));
    r.delete<P<'id'>>(`${W}/payments/:id`, async (req) => paymentsSvc.deletePayment(ctx.db, req.walletId, req.params.id, await clock(req)));

    // ---- Faturas
    r.get<P>(`${W}/invoices`, async (req) => invoicesSvc.listInvoices(ctx.db, req.walletId, parse(z.object({ month }), req.query).month, await clock(req)));
    r.get<P>(`${W}/invoice-preview`, async (req) => {
      const q = parse(z.object({ account: z.string().uuid(), date: isoDate }), req.query);
      return invoicesSvc.previewInvoice(ctx.db, req.walletId, q.account, q.date);
    });
    r.patch<P<'id'>>(`${W}/invoices/:id`, async (req) => {
      const b = parse(invoiceUpdateInput, req.body);
      return invoicesSvc.updateInvoiceDates(ctx.db, req.walletId, req.params.id, b.closingDate, b.dueDate, await clock(req));
    });
    r.post<P<'id'>>(`${W}/invoices/:id/payments`, async (req, reply) =>
      reply.status(201).send(await invoicesSvc.payInvoice(ctx.db, req.walletId, req.params.id, parse(invoicePaymentInput, req.body), req.userId, await clock(req))),
    );
    r.patch<P<'id'>>(`${W}/invoice-payments/:id`, async (req, reply) => {
      const b = parse(z.object({ paidAt: isoDate }), req.body);
      await invoicesSvc.updateInvoicePaymentDate(ctx.db, req.walletId, req.params.id, b.paidAt);
      return reply.status(204).send();
    });
    r.delete<P<'id'>>(`${W}/invoice-payments/:id`, async (req, reply) => {
      await invoicesSvc.deleteInvoicePayment(ctx.db, req.walletId, req.params.id);
      return reply.status(204).send();
    });

    // ---- Importação de extratos e faturas (ADR-0010). O arquivo fica só em memória.
    r.post<P>(`${W}/imports/preview`, { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
      const tooLarge = () => new AppError(413, 'file_too_large', 'O arquivo passa de 10 MB.');
      let file: Buffer | null = null;
      let password: string | undefined;
      // A senha (se houver) é usada só em memória e nunca registrada.
      for await (const part of req.parts({ limits: { fileSize: MAX_IMPORT_BYTES, files: 1, fields: 3, fieldSize: 1024 } })) {
        if (part.type === 'file') {
          file = await part.toBuffer().catch(() => {
            throw tooLarge();
          });
          if (part.file.truncated) throw tooLarge();
        } else if (part.fieldname === 'password' && typeof part.value === 'string') {
          password = part.value;
        }
      }
      if (!file) throw new AppError(400, 'import_unsupported_file', 'Escolha o arquivo do extrato ou da fatura.');
      return importSuggestSvc.previewImport(ctx, req.walletId, req.userId, file, password, await clock(req));
    });
    r.post<P>(`${W}/imports/suggest`, async (req) => {
      const { token, accountId } = parse(importSuggestInput, req.body);
      return importSuggestSvc.suggestImport(ctx, req.walletId, req.userId, token, accountId, await clock(req));
    });
    r.post<P>(`${W}/imports/confirm`, async (req) => importConfirmSvc.confirmImport(ctx, req.walletId, req.userId, parse(importConfirmInput, req.body), await clock(req)));

    // ---- Comprovantes
    const uploadOne = async (req: FastifyRequest) => {
      const file = await req.file({ limits: { fileSize: attachmentsSvc.MAX_BYTES, files: 1 } });
      if (!file) throw badRequest('Escolha um arquivo.');
      const buf = await file.toBuffer().catch(() => {
        throw badRequest('O arquivo passa de 10 MB.');
      });
      if (file.file.truncated) throw badRequest('O arquivo passa de 10 MB.');
      return attachmentsSvc.storeAttachment(ctx, req.walletId, req.userId, buf, file.filename);
    };
    r.post<P>(`${W}/attachments`, async (req, reply) => reply.status(201).send(await uploadOne(req)));
    r.post<P<'id'>>(`${W}/payments/:id/attachments`, async (req, reply) => {
      const pay = await ctx.db.query.payments.findFirst({ where: (p, { and, eq: e }) => and(e(p.id, req.params.id), e(p.walletId, req.walletId)) });
      if (!pay) throw notFound('Pagamento');
      const att = await uploadOne(req);
      await attachmentsSvc.attachToExisting(ctx, req.walletId, att.id, { paymentGroupId: pay.groupId });
      return reply.status(201).send(att);
    });
    r.post<P<'id'>>(`${W}/invoice-payments/:id/attachments`, async (req, reply) => {
      const pay = await ctx.db.query.invoicePayments.findFirst({ where: (p, { and, eq: e }) => and(e(p.id, req.params.id), e(p.walletId, req.walletId)) });
      if (!pay) throw notFound('Pagamento');
      const att = await uploadOne(req);
      await attachmentsSvc.attachToExisting(ctx, req.walletId, att.id, { invoicePaymentId: pay.id });
      return reply.status(201).send(att);
    });
    r.get<P<'id'>>(`${W}/attachments/:id`, async (req, reply) => {
      const a = await attachmentsSvc.readAttachment(ctx, req.walletId, req.params.id);
      return reply
        .header('Content-Type', a.mime)
        .header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(a.name)}`)
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .send(a.data);
    });
    r.delete<P<'id'>>(`${W}/attachments/:id`, async (req, reply) => {
      await attachmentsSvc.removeAttachment(ctx, req.walletId, req.params.id);
      return reply.status(204).send();
    });

    // ---- Resumo e navegação
    r.get<P>(`${W}/summary`, async (req) => summarySvc.monthSummary(ctx.db, req.walletId, parse(z.object({ month }), req.query).month, await clock(req)));
    r.get<P>(`${W}/months`, async (req) => summarySvc.monthsRange(ctx.db, req.walletId, await clock(req)));
  });
}
