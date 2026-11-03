import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { Me } from '@ff/shared';
import { Icon, type IconName } from '../components/Icon';
import { IconButton } from '../components/ui';
import { api } from '../lib/api';
import { useIsMobile } from '../lib/hooks';
import { queryClient } from '../lib/queries';

/** Barra lateral no computador; cabeçalho com menu no celular (design system: SidebarNav). */
export function AppShell({ me, children }: { me: Me; children: ReactNode }) {
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname, location.search]);

  const sidebar = <Sidebar me={me} />;
  if (!mobile) {
    return (
      <div className="app-shell">
        {sidebar}
        <main className="app-main" id="conteudo">
          {children}
        </main>
      </div>
    );
  }
  return (
    <div className="app-shell">
      <header className="ff-topbar">
        <IconButton icon="menu" label="Abrir menu" onClick={() => setOpen(true)} aria-expanded={open} />
        <p className="ff-wordmark">Finanças da Família</p>
      </header>
      {open && (
        <div className="app-drawer" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
          {sidebar}
        </div>
      )}
      <main className="app-main" id="conteudo">
        {children}
      </main>
    </div>
  );
}

function Sidebar({ me }: { me: Me }) {
  const navigate = useNavigate();
  // NavLink marca aria-current="page" no item ativo; o CSS do design system usa esse atributo.
  const item = (to: string, icon: IconName, label: string) => (
    <li>
      <NavLink to={to} end className="ff-nav__item">
        <Icon name={icon} />
        {label}
      </NavLink>
    </li>
  );
  async function logout() {
    await api.post('/api/auth/logout').catch(() => {});
    queryClient.clear();
    navigate('/entrar', { replace: true });
  }
  return (
    <aside className="ff-sidebar" aria-label="Menu principal">
      <p className="ff-wordmark">Finanças da Família</p>
      <p className="ff-nav__section">Menu principal</p>
      <ul className="ff-nav">{item('/', 'dashboard', 'Visão do mês')}</ul>
      <p className="ff-nav__section">Cadastros</p>
      <ul className="ff-nav">
        {item('/categorias', 'tag', 'Categorias')}
        {item('/contas', 'bank', 'Contas e cartões')}
      </ul>
      <ul className="ff-nav ff-nav--bottom">
        {item('/configuracoes', 'sliders', 'Configurações')}
        <li>
          <button type="button" className="ff-nav__item" style={{ border: 0, background: 'transparent', width: '100%', cursor: 'pointer' }} onClick={logout}>
            <Icon name="logout" />
            Sair
          </button>
        </li>
      </ul>
      <div className="app-user">
        <strong>{me.name}</strong>
        <span>{me.email}</span>
      </div>
    </aside>
  );
}
