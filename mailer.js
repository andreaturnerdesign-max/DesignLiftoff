// Sends the magic-link sign-in email over plain SMTP, so this works with
// any provider (Gmail with an app password, or a transactional email
// service like SendGrid/Postmark/Resend/Mailgun/Amazon SES's SMTP
// interface) — nothing provider-specific is hardcoded here.

const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const SMTP_SECURE = process.env.SMTP_SECURE === 'true'; // true typically means port 465

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error(
      'SMTP is not configured - set SMTP_HOST, SMTP_USER, and SMTP_PASS in your .env file. See .env.example.'
    );
  }
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

async function sendMagicLinkEmail(toEmail, link) {
  const t = getTransporter();
  await t.sendMail({
    from: SMTP_FROM,
    to: toEmail,
    subject: 'Your Design Liftoff sign-in link',
    text:
      `Sign in to Design Liftoff:\n\n${link}\n\n` +
      `This link expires in 15 minutes and can only be used once. ` +
      `If you didn't request this, you can safely ignore this email.`,
    html:
      `<p>Sign in to <strong>Design Liftoff</strong>:</p>` +
      `<p><a href="${link}">${link}</a></p>` +
      `<p style="color:#666;font-size:13px;">This link expires in 15 minutes and can only be used once. ` +
      `If you didn't request this, you can safely ignore this email.</p>`,
  });
}

module.exports = { sendMagicLinkEmail };
