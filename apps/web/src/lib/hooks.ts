import { useEffect, useState } from 'react';

/** Abaixo de 768px a interface usa o layout de celular (ADR-0009). */
export function useIsMobile(query = '(max-width: 767px)'): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const on = () => setMobile(mql.matches);
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, [query]);
  return mobile;
}

export type ThemeChoice = 'system' | 'light' | 'dark';

export function getTheme(): ThemeChoice {
  try {
    const t = localStorage.getItem('ff-theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function setTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem('ff-theme');
    else localStorage.setItem('ff-theme', choice);
  } catch {
    /* navegador sem armazenamento: vale só nesta visita */
  }
  if (choice === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', choice);
}

/** Data de hoje no fuso do navegador, em ISO. */
export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
