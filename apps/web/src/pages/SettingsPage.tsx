import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Me, NotificationSettings } from '@ff/shared';
import { Button, Field, Loading, Notice, Segmented, errorText, useToast } from '../components/ui';
import { api } from '../lib/api';
import { getTheme, setTheme, type ThemeChoice } from '../lib/hooks';
import { queryClient, useNotificationSettings } from '../lib/queries';

/** Avisos por email, aparência e sessões (ADR-0007, ADR-0009). */
export function SettingsPage({ me }: { me: Me }) {
  const settings = useNotificationSettings();
  const toast = useToast();
  const navigate = useNavigate();
  const [form, setForm] = useState<NotificationSettings | null>(null);
  const [theme, setThemeState] = useState<ThemeChoice>(getTheme());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (settings.data && !form) setForm(settings.data);
  }, [settings.data, form]);

  async function save() {
    if (!form) return;
    setBusy(true);
    setErr('');
    try {
      await api.patch('/api/me/notification-settings', form);
      await queryClient.invalidateQueries({ queryKey: ['notification-settings'] });
      toast('Avisos salvos.');
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-content" style={{ maxWidth: 760 }}>
      <h1 className="app-pagehead__title">Configurações</h1>

      <section className="ff-card">
        <header className="ff-card__header">
          <h2 className="ff-card__title">Avisos por email</h2>
        </header>
        <div className="ff-dialog__body" style={{ paddingTop: 0 }}>
          {!form ? (
            <Loading />
          ) : (
            <>
              <p className="ff-muted">
                Um resumo por dia em <strong>{me.email}</strong>, só quando houver contas para pagar ou valores para receber.
              </p>
              <label className="app-checkbox">
                <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
                Receber o resumo diário
              </label>
              <div className="app-grid2">
                <Field label="Horário do envio" htmlFor="hour">
                  <select id="hour" className="ff-select" value={form.sendHour} disabled={!form.enabled} onChange={(e) => setForm({ ...form, sendHour: Number(e.target.value) })}>
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>
                        {String(h).padStart(2, '0')}:00
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Avisar com antecedência de" htmlFor="lead">
                  <select id="lead" className="ff-select" value={form.leadBusinessDays} disabled={!form.enabled} onChange={(e) => setForm({ ...form, leadBusinessDays: Number(e.target.value) })}>
                    <option value={0}>Só no dia</option>
                    <option value={1}>1 dia útil</option>
                    <option value={2}>2 dias úteis</option>
                    <option value={3}>3 dias úteis</option>
                  </select>
                </Field>
              </div>
              <p className="ff-caption">Vencimento em fim de semana ou feriado é avisado no dia útil anterior.</p>
              {err && <Notice tone="danger">{err}</Notice>}
              <div>
                <Button variant="primary" onClick={save} busy={busy}>
                  Salvar avisos
                </Button>
              </div>
            </>
          )}
        </div>
      </section>

      <section className="ff-card">
        <header className="ff-card__header">
          <h2 className="ff-card__title">Aparência</h2>
        </header>
        <div className="ff-dialog__body" style={{ paddingTop: 0 }}>
          <Segmented
            label="Tema"
            value={theme}
            onChange={(t) => {
              setTheme(t);
              setThemeState(t);
            }}
            options={[
              { value: 'system', label: 'Igual ao aparelho' },
              { value: 'light', label: 'Claro' },
              { value: 'dark', label: 'Escuro' },
            ]}
          />
        </div>
      </section>

      <section className="ff-card">
        <header className="ff-card__header">
          <h2 className="ff-card__title">Segurança</h2>
        </header>
        <div className="ff-dialog__body" style={{ paddingTop: 0 }}>
          <p className="ff-muted">Use se perdeu um celular ou entrou num computador que não é seu.</p>
          <div>
            <Button
              variant="secondary"
              icon="logout"
              onClick={async () => {
                await api.post('/api/auth/logout-all').catch(() => {});
                queryClient.clear();
                navigate('/entrar', { replace: true });
              }}
            >
              Sair de todos os aparelhos
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
