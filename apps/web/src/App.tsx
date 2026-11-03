import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage, VerifyEmailPage } from './auth/AuthPages';
import { Loading } from './components/ui';
import { AppShell } from './layout/AppShell';
import { setSessionLostHandler } from './lib/api';
import { queryClient, useMe } from './lib/queries';
import { MonthPage } from './month/MonthPage';
import { AccountsPage } from './pages/AccountsPage';
import { CategoriesPage } from './pages/CategoriesPage';
import { SettingsPage } from './pages/SettingsPage';

/** Rotas em português, curtas, para quem digita ou recebe link por email. */
export function App() {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    setSessionLostHandler(() => {
      queryClient.clear();
      if (!location.pathname.startsWith('/entrar')) navigate('/entrar', { replace: true, state: { from: location.pathname + location.search } });
    });
  }, [navigate, location]);

  return (
    <Routes>
      <Route path="/entrar" element={<LoginPage />} />
      <Route path="/cadastro" element={<RegisterPage />} />
      <Route path="/verificar-email" element={<VerifyEmailPage />} />
      <Route path="/esqueci-senha" element={<ForgotPasswordPage />} />
      <Route path="/redefinir-senha" element={<ResetPasswordPage />} />
      <Route path="/*" element={<Protected />} />
    </Routes>
  );
}

function Protected() {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <Loading />;
  if (me.isError || !me.data) return <Navigate to="/entrar" replace state={{ from: location.pathname + location.search }} />;
  const walletId = me.data.wallets[0]?.id ?? '';
  return (
    <AppShell me={me.data}>
      <Routes>
        <Route path="/" element={<MonthPage walletId={walletId} />} />
        <Route path="/categorias" element={<CategoriesPage walletId={walletId} />} />
        <Route path="/contas" element={<AccountsPage walletId={walletId} />} />
        <Route path="/configuracoes" element={<SettingsPage me={me.data} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
