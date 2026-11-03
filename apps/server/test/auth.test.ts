import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, setup, signedIn, tokenFrom, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await setup();
});
afterAll(async () => env.close());

describe('autenticação', () => {
  it('exige confirmar o email antes de entrar', async () => {
    const c = new Client(env.app);
    expect((await c.post('/api/auth/register', { name: 'Ana', email: 'Ana@Example.com', password: 'senha-forte-1' })).statusCode).toBe(202);
    const login = await c.post('/api/auth/login', { email: 'ana@example.com', password: 'senha-forte-1' });
    expect(login.statusCode).toBe(403);
    expect(login.json().error.code).toBe('email_not_verified');

    const mail = env.mailer.sent.find((m) => m.to === 'ana@example.com')!;
    expect(mail.subject).toBe('Confirme seu email');
    expect((await c.post('/api/auth/verify-email', { token: tokenFrom(mail.text) })).statusCode).toBe(200);
    // o mesmo link não serve duas vezes
    expect((await c.post('/api/auth/verify-email', { token: tokenFrom(mail.text) })).json().error.code).toBe('invalid_token');

    const ok = await c.post('/api/auth/login', { email: 'ana@example.com', password: 'senha-forte-1' });
    expect(ok.statusCode).toBe(200);
    expect(c.cookies.has('ff_access')).toBe(true);
    expect(c.cookies.has('ff_refresh')).toBe(true);
  });

  it('cria carteira pessoal, categorias padrão e não revela emails existentes', async () => {
    const c = await signedIn(env, 'bia@example.com', 'Bia');
    const me = (await c.get('/api/me')).json();
    expect(me.wallets).toEqual([expect.objectContaining({ name: 'Pessoal', kind: 'personal', role: 'owner' })]);
    const cats = (await c.get(c.w('/categories'))).json();
    expect(cats.map((x: { name: string }) => x.name)).toContain('Alimentação');
    // cadastro repetido responde igual
    const again = await new Client(env.app).post('/api/auth/register', { name: 'X', email: 'bia@example.com', password: 'outra-senha-1' });
    expect(again.statusCode).toBe(202);
    const wrong = await new Client(env.app).post('/api/auth/login', { email: 'bia@example.com', password: 'errada-123' });
    expect(wrong.json().error.code).toBe('invalid_credentials');
  });

  it('roda o refresh e revoga a família ao detectar reuso', async () => {
    const c = await signedIn(env, 'caio@example.com', 'Caio');
    const oldRefresh = c.cookies.get('ff_refresh')!;
    expect((await c.post('/api/auth/refresh')).statusCode).toBe(200);
    const newRefresh = c.cookies.get('ff_refresh')!;
    expect(newRefresh).not.toBe(oldRefresh);

    // Um atacante reusa o token antigo depois da janela de tolerância.
    env.setNow('2026-11-03T15:05:00Z');
    const thief = new Client(env.app);
    thief.cookies.set('ff_refresh', oldRefresh);
    expect((await thief.post('/api/auth/refresh')).statusCode).toBe(401);
    // A família toda caiu: o token legítimo também não serve mais.
    expect((await c.post('/api/auth/refresh')).statusCode).toBe(401);
    env.setNow('2026-11-03T15:00:00Z');
  });

  it('sair de todos os dispositivos derruba o access token na hora', async () => {
    const c = await signedIn(env, 'duda@example.com', 'Duda');
    const access = c.cookies.get('ff_access')!;
    expect((await c.post('/api/auth/logout-all')).statusCode).toBe(200);
    const other = new Client(env.app);
    other.cookies.set('ff_access', access);
    expect((await other.get('/api/me')).statusCode).toBe(401);
  });

  it('redefine a senha por link de uso único', async () => {
    await signedIn(env, 'edu@example.com', 'Edu');
    const c = new Client(env.app);
    expect((await c.post('/api/auth/forgot-password', { email: 'nao-existe@example.com' })).statusCode).toBe(202);
    await c.post('/api/auth/forgot-password', { email: 'edu@example.com' });
    const mail = env.mailer.sent.filter((m) => m.to === 'edu@example.com').at(-1)!;
    expect(mail.subject).toBe('Redefinir sua senha');
    expect((await c.post('/api/auth/reset-password', { token: tokenFrom(mail.text), password: 'nova-senha-123' })).statusCode).toBe(200);
    expect((await c.post('/api/auth/login', { email: 'edu@example.com', password: 'senha-forte-1' })).statusCode).toBe(401);
    expect((await c.post('/api/auth/login', { email: 'edu@example.com', password: 'nova-senha-123' })).statusCode).toBe(200);
  });

  it('isola carteiras: ninguém acessa a carteira de outro', async () => {
    const a = await signedIn(env, 'fabi@example.com', 'Fabi');
    const b = await signedIn(env, 'gui@example.com', 'Gui');
    const res = await b.get(`/api/wallets/${a.walletId}/categories`);
    expect(res.statusCode).toBe(403);
    expect((await new Client(env.app).get(a.w('/categories'))).statusCode).toBe(401);
  });
});
