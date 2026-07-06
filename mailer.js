// Sends the magic-link sign-in email via Resend's HTTPS API — not SMTP.
//
// This matters specifically because many free-tier hosts (Render's
// included) block outbound traffic on SMTP ports (25, 465, 587), but
// allow normal HTTPS requests. Using Resend's API instead of SMTP means
// this works on a free Render instance without any special networking.
//
// Uses Node's built-in fetch (Node 18+) - no extra dependency needed.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM;

async function sendMagicLinkEmail(toEmail, link) {
  if (!RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not set - see .env.example.');
  }
  if (!EMAIL_FROM) {
    throw new Error('EMAIL_FROM is not set - see .env.example.');
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [toEmail],
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
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

module.exports = { sendMagicLinkEmail };
