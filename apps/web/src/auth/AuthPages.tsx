import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Field, Notice, errorText, fieldErrors } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { queryClient } from '../lib/queries';

/** Telas fora do app: entrar, cadastro, confirmação de email e senha (ADR-0003). */

function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="app-auth">
      <div className="app-auth__card">
        <p className="app-auth__brand">Finanças da Família</p>
        <h1 className="app-auth__title">{title}</h1>
        {children}
      </div>
    </main>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [resent, setResent] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/login', { email, password });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== '/entrar' ? from : '/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'x', errorText(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Entrar">
      <form className="app-form" onSubmit={submit} noValidate>
        <Field label="Email" htmlFor="email">
          <input id="email" className="ff-input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </Field>
        <Field label="Senha" htmlFor="password">
          <input id="password" className="ff-input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {error && (
          <Notice tone="danger">
            {error.message}{' '}
            {error.code === 'email_not_verified' && !resent && (
              <button
                type="button"
                className="app-linklike"
                onClick={async () => {
                  await api.post('/api/auth/resend-verification', { email }).catch(() => {});
                  setResent(true);
                }}
              >
                Reenviar o link
              </button>
            )}
            {resent && ' Enviamos um novo link.'}
          </Notice>
        )}
        <Button type="submit" variant="primary" block busy={busy}>
          Entrar
        </Button>
      </form>
      <div className="app-auth__links">
        <Link to="/esqueci-senha">Esqueci minha senha</Link>
        <Link to="/cadastro">Criar conta</Link>
      </div>
    </AuthCard>
  );
}

export function RegisterPage() {
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const f = fieldErrors(err);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.post('/api/auth/register', form);
      setDone(true);
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <AuthCard title="Confira seu email">
        <p>
          Enviamos um link para <strong>{form.email}</strong>. Abra o email e toque em <strong>Confirmar email</strong> para começar.
        </p>
        <p className="ff-muted">Não chegou? Olhe a caixa de spam. O link vale por 24 horas.</p>
        <Link to="/entrar">Voltar para entrar</Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Criar conta">
      <form className="app-form" onSubmit={submit} noValidate>
        <Field label="Seu nome" htmlFor="name" error={f.name}>
          <input id="name" className="ff-input" autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
        </Field>
        <Field label="Email" htmlFor="email" error={f.email}>
          <input id="email" className="ff-input" type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Senha" htmlFor="password" hint="Pelo menos 8 caracteres." error={f.password}>
          <input id="password" className="ff-input" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        {err && !Object.keys(f).length ? <Notice tone="danger">{errorText(err)}</Notice> : null}
        <Button type="submit" variant="primary" block busy={busy}>
          Criar conta
        </Button>
      </form>
      <div className="app-auth__links">
        <Link to="/entrar">Já tenho conta</Link>
      </div>
    </AuthCard>
  );
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [msg, setMsg] = useState('');
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    api
      .post('/api/auth/verify-email', { token: params.get('token') ?? '' })
      .then(() => setState('ok'))
      .catch((e) => {
        setMsg(errorText(e));
        setState('error');
      });
  }, [params]);
  return (
    <AuthCard title={state === 'ok' ? 'Email confirmado' : state === 'error' ? 'Não deu certo' : 'Confirmando…'}>
      {state === 'ok' && <p>Tudo certo. Agora é só entrar com seu email e senha.</p>}
      {state === 'error' && <Notice tone="danger">{msg}</Notice>}
      {state !== 'loading' && (
        <Link className="ff-btn ff-btn--primary" to="/entrar">
          Ir para entrar
        </Link>
      )}
    </AuthCard>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    await api.post('/api/auth/forgot-password', { email }).catch(() => {});
    setBusy(false);
    setSent(true);
  }
  return (
    <AuthCard title="Esqueci minha senha">
      {sent ? (
        <p>Se esse email tiver uma conta, enviamos um link para criar uma nova senha. O link vale por 1 hora.</p>
      ) : (
        <form className="app-form" onSubmit={submit}>
          <Field label="Email da sua conta" htmlFor="email">
            <input id="email" className="ff-input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          <Button type="submit" variant="primary" block busy={busy}>
            Enviar link
          </Button>
        </form>
      )}
      <Link to="/entrar">Voltar para entrar</Link>
    </AuthCard>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.post('/api/auth/reset-password', { token: params.get('token') ?? '', password });
      navigate('/entrar', { replace: true });
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthCard title="Criar nova senha">
      <form className="app-form" onSubmit={submit}>
        <Field label="Nova senha" htmlFor="password" hint="Pelo menos 8 caracteres." error={fieldErrors(err).password}>
          <input id="password" className="ff-input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </Field>
        {err && !fieldErrors(err).password ? <Notice tone="danger">{errorText(err)}</Notice> : null}
        <Button type="submit" variant="primary" block busy={busy}>
          Salvar senha
        </Button>
      </form>
    </AuthCard>
  );
}
