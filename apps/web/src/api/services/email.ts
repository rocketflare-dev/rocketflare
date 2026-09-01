/**
 * Transactional email over Resend's REST API via `fetch` (no SDK) — D16 zero-creds rule: when
 * `RESEND_API_KEY` is absent nothing is sent, the message (and its link) is logged at `info` so
 * every flow still works locally, and the result says `delivered: false`. Templates share one
 * plain, brandable shell driven by `APP_NAME`.
 */
import type { AppConfig } from '../../config'
import type { Logger } from '../utils/core/logger'

export interface EmailMessage {
  to: string
  subject: string
  html: string
  text: string
  /** The one URL the recipient must reach — logged prominently when email is not configured. */
  link?: string
}

export interface EmailResult {
  delivered: boolean
  id?: string
  error?: string
}

type EmailLogger = Pick<Logger, 'info' | 'warn' | 'error'>

const RESEND_URL = 'https://api.resend.com/emails'

export async function sendEmail(
  cfg: AppConfig,
  logger: EmailLogger,
  message: EmailMessage
): Promise<EmailResult> {
  if (!cfg.RESEND_API_KEY) {
    logger.info(
      { to: message.to, subject: message.subject, link: message.link },
      `[email:dev] To: ${message.to} Subject: ${message.subject}${message.link ? ` Link: ${message.link}` : ''}`
    )
    if (message.link) {
      // Deliberately loud: this is how a developer without an email provider signs in.
      logger.info(
        `\n==================== [email:dev] ${message.subject} ====================\n${message.link}\n=========================================================================\n`
      )
    }
    if (cfg.APP_ENV === 'production') {
      logger.warn('RESEND_API_KEY is not set — emails are logged, not delivered')
    }
    return { delivered: false }
  }
  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: cfg.EMAIL_FROM,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      logger.error({ status: res.status, body }, 'Resend rejected the email')
      return { delivered: false, error: `Resend ${res.status}` }
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string }
    return { delivered: true, id: data.id }
  } catch (err) {
    logger.error({ err }, 'Email delivery failed')
    return { delivered: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---- Templates ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const palette = {
  canvas: '#f4f4f5',
  panel: '#ffffff',
  border: '#d4d4d8',
  text: '#18181b',
  muted: '#52525b',
  primary: '#1f2937',
}

/** Plain table-based shell; inline styles because email clients ignore stylesheets. */
export function emailShell(cfg: AppConfig, title: string, bodyHtml: string): string {
  const app = escapeHtml(cfg.APP_NAME)
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:${palette.canvas};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${palette.text};">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${palette.canvas};"><tr><td style="padding:32px 16px;">
<table role="presentation" width="600" align="center" cellspacing="0" cellpadding="0" style="max-width:600px;margin:0 auto;background:${palette.panel};border:1px solid ${palette.border};border-radius:8px;">
<tr><td style="padding:20px 24px;border-bottom:1px solid ${palette.border};font-size:20px;font-weight:600;color:${palette.primary};">${app}</td></tr>
<tr><td style="padding:32px 24px;font-size:16px;line-height:1.5;">${bodyHtml}</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid ${palette.border};font-size:12px;color:${palette.muted};">Sent by ${app}</td></tr>
</table></td></tr></table></body></html>`
}

function button(url: string, label: string): string {
  return `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 24px;background:${palette.primary};color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;">${escapeHtml(label)}</a></p>
<p style="font-size:13px;color:${palette.muted};word-break:break-all;">Or paste this link into your browser:<br>${escapeHtml(url)}</p>`
}

export function magicLinkEmail(cfg: AppConfig, to: string, verifyUrl: string): EmailMessage {
  const subject = `Sign in to ${cfg.APP_NAME}`
  const body = `<h1 style="margin:0 0 16px;font-size:22px;">Your sign-in link</h1>
<p>Click the button below to sign in to ${escapeHtml(cfg.APP_NAME)}. The link expires in 15 minutes and can be used once.</p>
${button(verifyUrl, `Sign in to ${cfg.APP_NAME}`)}
<p style="font-size:13px;color:${palette.muted};">If you did not request this email you can ignore it.</p>`
  return {
    to,
    subject,
    html: emailShell(cfg, subject, body),
    text: `Sign in to ${cfg.APP_NAME}: ${verifyUrl}\n\nThis link expires in 15 minutes. If you did not request it, ignore this email.`,
    link: verifyUrl,
  }
}

export function invitationEmail(
  cfg: AppConfig,
  to: string,
  input: { tenantName: string; inviterName: string; role: string; acceptUrl: string }
): EmailMessage {
  const subject = `You've been invited to ${input.tenantName}`
  const body = `<h1 style="margin:0 0 16px;font-size:22px;">Join ${escapeHtml(input.tenantName)}</h1>
<p>${escapeHtml(input.inviterName)} has invited you to join <strong>${escapeHtml(input.tenantName)}</strong> on ${escapeHtml(cfg.APP_NAME)} as ${escapeHtml(input.role)}.</p>
${button(input.acceptUrl, 'Accept invitation')}
<p style="font-size:13px;color:${palette.muted};">This invitation expires in 7 days. If you were not expecting it you can ignore this email.</p>`
  return {
    to,
    subject,
    html: emailShell(cfg, subject, body),
    text: `${input.inviterName} invited you to join ${input.tenantName} on ${cfg.APP_NAME} as ${input.role}.\n\nAccept: ${input.acceptUrl}\n\nThe invitation expires in 7 days.`,
    link: input.acceptUrl,
  }
}

export function accessRequestDecidedEmail(
  cfg: AppConfig,
  to: string,
  input: { approved: boolean; tenantName?: string; reason?: string }
): EmailMessage {
  const subject = input.approved
    ? `Your ${cfg.APP_NAME} access is approved`
    : `Your ${cfg.APP_NAME} access request`
  const body = input.approved
    ? `<h1 style="margin:0 0 16px;font-size:22px;">You're in</h1>
<p>Your request has been approved${input.tenantName ? ` and you have been added to <strong>${escapeHtml(input.tenantName)}</strong>` : ''}. Sign in with the same email address to get started.</p>
${button(cfg.APP_URL, `Open ${cfg.APP_NAME}`)}`
    : `<h1 style="margin:0 0 16px;font-size:22px;">Request not approved</h1>
<p>Your request to access ${escapeHtml(cfg.APP_NAME)} was not approved.${input.reason ? ` Reason: ${escapeHtml(input.reason)}` : ''}</p>`
  const text = input.approved
    ? `Your ${cfg.APP_NAME} access request was approved${input.tenantName ? ` (${input.tenantName})` : ''}. Sign in at ${cfg.APP_URL}`
    : `Your ${cfg.APP_NAME} access request was not approved.${input.reason ? ` Reason: ${input.reason}` : ''}`
  return {
    to,
    subject,
    html: emailShell(cfg, subject, body),
    text,
    link: input.approved ? cfg.APP_URL : undefined,
  }
}
