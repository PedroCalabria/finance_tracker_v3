import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { migrationsFolder, runMigrations } from '../src/db/migrate';
import { TEST_DB } from './helpers';

/**
 * Backfill do mês do gasto (migração 0003, ADR-0004): lançamentos gravados antes dela
 * recebem `charge_month` pela data da compra, pelo número da parcela e, nas recorrentes
 * no crédito, pelo fechamento da fatura.
 */
describe('migração 0003: backfill do mês do gasto', () => {
  const { db, pool } = createDb(TEST_DB);
  const tmp = mkdtempSync(path.join(tmpdir(), 'ff-migrations-'));
  afterAll(async () => {
    rmSync(tmp, { recursive: true, force: true });
    await pool.end();
  });

  it('preenche o mês do gasto dos lançamentos existentes', async () => {
    await pool.query('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;');
    // Até a 0002: cópia das migrações com o journal cortado antes da 0003.
    cpSync(migrationsFolder(), tmp, { recursive: true });
    const journalPath = path.join(tmp, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    const upTo = journal.entries.findIndex((e: { tag: string }) => e.tag === '0003_mes_do_gasto');
    expect(upTo).toBeGreaterThan(0);
    writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }));
    await migrate(drizzle(pool), { migrationsFolder: tmp });

    const one = async (q: string, params: unknown[] = []) => (await pool.query(q, params)).rows[0];
    const wallet = (await one(`insert into wallets (name, kind) values ('W', 'personal') returning id`)).id;
    // Cartão que fecha dia 25 e vence dia 1.
    const card = (await one(`insert into accounts (wallet_id, name, bank, kind, closing_day, due_day) values ($1, 'Nu', 'Nubank', 'credit_card', 25, 1) returning id`, [wallet])).id;
    const inv: Record<string, string> = {};
    for (const [month, closing, due] of [
      ['2026-11', '2026-10-25', '2026-11-01'],
      ['2026-12', '2026-11-25', '2026-12-01'],
      ['2027-01', '2026-12-25', '2027-01-01'],
      ['2027-02', '2027-01-25', '2027-02-01'],
    ]) {
      inv[month!] = (await one(`insert into invoices (wallet_id, account_id, reference_month, closing_date, due_date) values ($1, $2, $3, $4, $5) returning id`, [wallet, card, month, closing, due])).id;
    }
    const item = async (form: string, method: string, entry: string, extra = '', extraVals: unknown[] = []) =>
      (
        await one(
          `insert into items (wallet_id, type, form, description, method, account_id, entry_date, start_month${extra ? `, ${extra}` : ''})
           values ($1, 'expense', $2, $3, $4, $5, $6, $7${extraVals.map((_, i) => `, $${8 + i}`).join('')}) returning id`,
          [wallet, form, `${form}-${entry}`, method, method === 'credit' ? card : null, entry, entry.slice(0, 7), ...extraVals],
        )
      ).id as string;
    const occ = async (itemId: string, month: string, n: number | null, invoice: string | null) =>
      (
        await one(
          `insert into occurrences (wallet_id, item_id, competence_month, installment_number, expected_cents, invoice_id) values ($1, $2, $3, $4, 100, $5) returning id`,
          [wallet, itemId, month, n, invoice],
        )
      ).id as string;

    // Única no crédito de 28/10, na fatura de dez → out.
    const single = await occ(await item('single', 'credit', '2026-10-28'), '2026-12', null, inv['2026-12']!);
    // Parcelada de 10/11 → nov, dez, jan.
    const inst = await item('installment', 'credit', '2026-11-10', 'installments, total_cents', [3, 300]);
    const parcels = [await occ(inst, '2026-12', 1, inv['2026-12']!), await occ(inst, '2027-01', 2, inv['2027-01']!), await occ(inst, '2027-02', 3, inv['2027-02']!)];
    // Parcela antiga importada da fatura ("PARC 08/10" de março, na fatura de nov) → mês anterior ao da fatura.
    const imported = await occ(await item('installment', 'credit', '2026-03-21', 'installments, total_cents', [3, 300]), '2026-11', 1, inv['2026-11']!);
    // Última parcela antiga ("PARC 06/06" de maio) importada como única, na fatura de nov → mês anterior ao da fatura.
    const lastParcel = await occ(await item('single', 'credit', '2026-05-26'), '2026-11', null, inv['2026-11']!);
    // Recorrente no crédito dia 28: a fatura de jan (fecha 25/12) é a da cobrança de 28/11; dia 10: a de dez é a de 10/11.
    const rec28 = await occ(await item('recurring', 'credit', '2026-10-28'), '2027-01', null, inv['2027-01']!);
    const rec10 = await occ(await item('recurring', 'credit', '2026-11-10'), '2026-12', null, inv['2026-12']!);
    // Fora do crédito: o próprio mês. Ajuste da fatura: o mês da fatura.
    const boleto = await occ(await item('single', 'boleto', '2026-10-03'), '2026-10', null, null);
    const adjustment = await occ(await item('single', 'credit', '2026-11-25', 'system_kind', ['invoice_adjustment']), '2026-12', null, inv['2026-12']!);

    await runMigrations(db);
    const charge = async (id: string) => (await one('select charge_month from occurrences where id = $1', [id])).charge_month;
    expect(await charge(single)).toBe('2026-10');
    expect(await Promise.all(parcels.map(charge))).toEqual(['2026-11', '2026-12', '2027-01']);
    expect([await charge(imported), await charge(lastParcel)]).toEqual(['2026-10', '2026-10']);
    expect([await charge(rec28), await charge(rec10)]).toEqual(['2026-11', '2026-11']);
    expect([await charge(boleto), await charge(adjustment)]).toEqual(['2026-10', '2026-12']);
    const nulls = await one('select count(*)::int as n from occurrences where charge_month is null');
    expect(nulls.n).toBe(0);
  });
});
