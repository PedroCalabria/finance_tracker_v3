import { describe, expect, it } from 'vitest';
import { SUPERSEDED_WAIT_MS, sendWithSessionRetry, shareInFlight, type RenewOutcome } from './session-retry';

/** Cenário falso: respostas por status em sequência, renovação com resultado fixo. */
function scenario(statuses: number[], outcome: RenewOutcome | Error = 'ok') {
  const log: string[] = [];
  let i = 0;
  const deps = {
    send: async () => {
      const s = statuses[i++];
      if (s === undefined) throw new Error('chamada a mais');
      if (s === 0) throw new Error('offline');
      log.push(`send:${s}`);
      return s;
    },
    isUnauthorized: (s: number) => s === 401,
    renew: async () => {
      log.push('renew');
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    sleep: async (ms: number) => {
      log.push(`sleep:${ms}`);
    },
    onSessionLost: () => log.push('lost'),
  };
  return { deps, log };
}

describe('renovação da sessão no cliente', () => {
  it('sem 401, não renova', async () => {
    const { deps, log } = scenario([200]);
    expect(await sendWithSessionRetry('/api/me', deps)).toBe(200);
    expect(log).toEqual(['send:200']);
  });

  it('401 (cookie já apagado) → renova → repete', async () => {
    const { deps, log } = scenario([401, 200]);
    expect(await sendWithSessionRetry('/api/me', deps)).toBe(200);
    expect(log).toEqual(['send:401', 'renew', 'send:200']);
  });

  it('renovação falhou, mas outra aba já renovou: a repetição passa e a sessão continua', async () => {
    const { deps, log } = scenario([401, 200], 'failed');
    expect(await sendWithSessionRetry('/api/wallets/x/summary', deps)).toBe(200);
    expect(log).toEqual(['send:401', 'renew', 'send:200']);
  });

  it('perdeu a corrida: espera um instante antes de repetir', async () => {
    const { deps, log } = scenario([401, 200], 'superseded');
    expect(await sendWithSessionRetry('/api/me', deps)).toBe(200);
    expect(log).toEqual(['send:401', 'renew', `sleep:${SUPERSEDED_WAIT_MS}`, 'send:200']);
  });

  it('repetição também 401: sessão perdida, uma vez só', async () => {
    const { deps, log } = scenario([401, 401], 'failed');
    expect(await sendWithSessionRetry('/api/me', deps)).toBe(401);
    expect(log).toEqual(['send:401', 'renew', 'send:401', 'lost']);
  });

  it('sem rede na renovação ou na repetição: erro de conexão, sem ir para o login', async () => {
    const a = scenario([401], new Error('offline'));
    await expect(sendWithSessionRetry('/api/me', a.deps)).rejects.toThrow('offline');
    expect(a.log).not.toContain('lost');
    const b = scenario([401, 0]);
    await expect(sendWithSessionRetry('/api/me', b.deps)).rejects.toThrow('offline');
    expect(b.log).not.toContain('lost');
  });

  it('rotas de /api/auth/ não renovam (senha errada não é sessão vencida)', async () => {
    const { deps, log } = scenario([401]);
    expect(await sendWithSessionRetry('/api/auth/login', deps)).toBe(401);
    expect(log).toEqual(['send:401']);
  });

  it('N chamadas ao mesmo tempo compartilham uma renovação', async () => {
    let calls = 0;
    let release!: () => void;
    const renew = shareInFlight(async (): Promise<RenewOutcome> => {
      calls++;
      await new Promise<void>((r) => (release = r));
      return 'ok';
    });
    const pending = Array.from({ length: 5 }, () => renew());
    release();
    expect(await Promise.all(pending)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(calls).toBe(1);
    // Terminada, a próxima chamada renova de novo.
    const next = renew();
    release();
    await next;
    expect(calls).toBe(2);
  });
});
