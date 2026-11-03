import type { EmailMessage } from './mailer';

/**
 * Emails simples, legíveis em qualquer cliente: HTML com estilos inline e
 * versão em texto puro. Cores do design system (tema claro).
 */

const C = { ink: '#152022', muted: '#56635f', primary: '#256f73', bg: '#f5f7f7', border: '#e2e8e8' };

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;padding:24px;background:${C.bg};font-family:Segoe UI,Arial,sans-serif;color:${C.ink};font-size:16px;line-height:24px">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid ${C.border};border-radius:14px;padding:24px">
<p style="margin:0 0 16px;font-weight:700;font-size:18px">Finanças da Família</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:28px">${esc(title)}</h1>
${bodyHtml}
</div>
<p style="max-width:560px;margin:16px auto 0;color:${C.muted};font-size:13px;line-height:18px">Você recebeu este email porque tem uma conta no Finanças da Família.</p>
</body></html>`;
}

export function button(href: string, label: string): string {
  return `<p style="margin:24px 0"><a href="${esc(href)}" style="display:inline-block;background:${C.primary};color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px">${esc(label)}</a></p>`;
}

export function verifyEmail(to: string, name: string, link: string): EmailMessage {
  return {
    to,
    subject: 'Confirme seu email',
    html: layout('Confirme seu email', `<p>Olá, ${esc(name)}. Para começar a usar sua conta, confirme seu email.</p>${button(link, 'Confirmar email')}<p style="color:${C.muted};font-size:14px">O link vale por 24 horas.</p>`),
    text: `Olá, ${name}. Para começar a usar sua conta, confirme seu email:\n${link}\n\nO link vale por 24 horas.`,
  };
}

export function resetPassword(to: string, name: string, link: string): EmailMessage {
  return {
    to,
    subject: 'Redefinir sua senha',
    html: layout('Redefinir sua senha', `<p>Olá, ${esc(name)}. Recebemos um pedido para redefinir sua senha.</p>${button(link, 'Criar nova senha')}<p style="color:${C.muted};font-size:14px">O link vale por 1 hora e só pode ser usado uma vez. Se não foi você, ignore este email: sua senha continua a mesma.</p>`),
    text: `Olá, ${name}. Para criar uma nova senha, abra:\n${link}\n\nO link vale por 1 hora. Se não foi você, ignore este email.`,
  };
}
