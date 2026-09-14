/**
 * The password-reset email, as plain content. Pure and provider-agnostic, so a
 * unit test can pin it and any driver (SMTP today, an HTTP provider later) can
 * render the same message. It never logs or embeds anything but the code.
 */
export interface ResetEmail {
  subject: string;
  text: string;
  html: string;
}

export function renderResetCodeEmail(input: {
  code: string;
  expiresInSeconds: number;
  appName: string;
}): ResetEmail {
  const minutes = Math.max(1, Math.round(input.expiresInSeconds / 60));
  const unit = minutes === 1 ? 'minute' : 'minutes';
  const subject = `Your ${input.appName} password reset code`;
  const text =
    `Your ${input.appName} password reset code is ${input.code}.\n` +
    `It expires in ${minutes} ${unit}.\n\n` +
    `If you did not request a password reset, you can ignore this message.`;
  const html =
    `<p>Your ${escapeHtml(input.appName)} password reset code is:</p>` +
    `<p style="font-size:24px;font-weight:bold;letter-spacing:4px">${input.code}</p>` +
    `<p>It expires in ${minutes} ${unit}.</p>` +
    `<p style="color:#666">If you did not request a password reset, you can ignore this message.</p>`;
  return { subject, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
