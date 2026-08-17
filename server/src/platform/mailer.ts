import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import nodemailer from 'nodemailer';
import { config, pool } from '../db.js';

/* ---------------------------------------------------------------------------
 * SMTP is configured from the admin panel, not from the environment, so the
 * credentials live in the `settings` table. A mail password in a plaintext
 * column is a credential anyone with a database dump inherits, so the password
 * — and only the password — is encrypted at rest with a key derived from
 * JWT_SECRET.
 *
 * Consequence worth knowing: rotate JWT_SECRET and the stored password can no
 * longer be decrypted. Nothing breaks except sending, and the admin re-enters
 * it. That is the right trade for not storing it in the clear.
 * ------------------------------------------------------------------------- */

const KEY = scryptSync(config.jwtSecret, 'chotug-smtp-v1', 32);

export function encryptSecret(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${enc.toString('base64url')}`;
}

export function decryptSecret(stored: string): string | null {
  try {
    const [v, iv, tag, data] = stored.split(':');
    if (v !== 'v1') return null;
    const d = createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch {
    // Wrong key (JWT_SECRET rotated) or tampered value. Treat as unconfigured.
    return null;
  }
}

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string | null;
  fromName: string;
  fromEmail: string;
};

export const SMTP_KEYS = [
  'smtp.host', 'smtp.port', 'smtp.secure', 'smtp.user',
  'smtp.password', 'smtp.from_name', 'smtp.from_email',
] as const;

/** Reads the company's SMTP settings. Returns null unless enough is present to
 *  actually send — a half-filled form is not a configuration. */
export async function loadSmtp(companyId: string): Promise<SmtpConfig | null> {
  const { rows } = await pool.query(
    `SELECT key, value FROM settings WHERE company_id = $1 AND key LIKE 'smtp.%'`,
    [companyId],
  );
  if (!rows.length) return null;

  const v = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Record<string, any>;
  const host = String(v['smtp.host'] ?? '').trim();
  const user = String(v['smtp.user'] ?? '').trim();
  const fromEmail = String(v['smtp.from_email'] ?? '').trim() || user;
  const stored = v['smtp.password'] ? String(v['smtp.password']) : '';
  const password = stored ? decryptSecret(stored) : null;

  if (!host || !fromEmail) return null;

  return {
    host,
    port: Number(v['smtp.port'] ?? 587),
    secure: v['smtp.secure'] === true || v['smtp.secure'] === 'true',
    user,
    password,
    fromName: String(v['smtp.from_name'] ?? 'ChotuG').trim() || 'ChotuG',
    fromEmail,
  };
}

function transportFor(c: SmtpConfig) {
  return nodemailer.createTransport({
    host: c.host,
    port: c.port,
    // Port 465 is implicit TLS; 587 upgrades with STARTTLS. Getting this wrong
    // is the most common reason a "correct" SMTP setup hangs.
    secure: c.secure || c.port === 465,
    auth: c.user ? { user: c.user, pass: c.password ?? '' } : undefined,
    connectionTimeout: 12_000,
    greetingTimeout: 12_000,
    socketTimeout: 20_000,
  });
}

export type SendResult = { sent: boolean; reason?: string };

export async function sendMail(
  companyId: string,
  to: string,
  subject: string,
  html: string,
  text: string,
): Promise<SendResult> {
  const c = await loadSmtp(companyId);
  if (!c) return { sent: false, reason: 'SMTP is not set up yet' };
  try {
    await transportFor(c).sendMail({
      from: `"${c.fromName}" <${c.fromEmail}>`,
      to, subject, text, html,
    });
    return { sent: true };
  } catch (e: any) {
    console.error('[smtp] send failed', e?.message);
    return { sent: false, reason: e?.message ?? 'The mail server refused the message' };
  }
}

/** Proves the settings work before an invite depends on them. */
export async function sendTestMail(companyId: string, to: string): Promise<SendResult> {
  return sendMail(
    companyId, to,
    'ChotuG — test email',
    `<p>This is a test from ChotuG. Your mail settings are working.</p>`,
    'This is a test from ChotuG. Your mail settings are working.',
  );
}

export function inviteEmail(fullName: string, companyName: string, roleName: string | null, url: string) {
  const who = fullName.split(' ')[0];
  const role = roleName ? ` as <b>${roleName}</b>` : '';
  const roleText = roleName ? ` as ${roleName}` : '';
  return {
    subject: `You have been added to ${companyName} on ChotuG`,
    text:
      `Hi ${who},\n\n${companyName} has added you to ChotuG${roleText}.\n\n` +
      `Set your password here — the link works once and expires in 7 days:\n${url}\n\n` +
      `If you were not expecting this, ignore this email.\n`,
    html:
      `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;color:#0F172A;line-height:1.55">
         <p>Hi ${who},</p>
         <p><b>${companyName}</b> has added you to ChotuG${role}.</p>
         <p>
           <a href="${url}" style="display:inline-block;background:#4338CA;color:#fff;
              text-decoration:none;padding:11px 20px;border-radius:7px;font-weight:600">
             Set your password
           </a>
         </p>
         <p style="color:#64748B;font-size:13px">
           The link works once and expires in 7 days. If the button does not work,
           paste this into your browser:<br>
           <span style="word-break:break-all">${url}</span>
         </p>
         <p style="color:#64748B;font-size:13px">If you were not expecting this, ignore this email.</p>
       </div>`,
  };
}
