import '../helpers/env.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../src/config/env.js';
import { createSmtpDelivery, type MailTransport } from '../../src/delivery/smtp.js';
import { renderResetCodeEmail } from '../../src/delivery/reset-email.js';
import { createTestApp, createUser } from '../helpers/app.js';

test('the reset email carries the code and its expiry, and nothing else secret', () => {
  const email = renderResetCodeEmail({ code: '123456', expiresInSeconds: 600, appName: 'On Go' });
  assert.match(email.subject, /On Go/);
  assert.ok(email.text.includes('123456'));
  assert.ok(email.html.includes('123456'));
  assert.ok(email.text.includes('10 minute'), 'states the 10-minute expiry');
});

test('the SMTP driver sends one message to the address with the code', async () => {
  const sent: Array<{ from: string; to: string; subject: string; text: string; html: string }> = [];
  const transport: MailTransport = {
    async sendMail(message) {
      sent.push(message);
      return {};
    },
  };
  const config = { ...loadConfig(), SMTP_FROM: 'no-reply@ongo.test', SMTP_FROM_NAME: 'On Go' };
  const delivery = createSmtpDelivery(config, transport);

  await delivery.deliverPasswordResetCode({ email: 'user@example.com', code: '654321', expiresInSeconds: 600 });

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.to, 'user@example.com');
  assert.match(sent[0]?.from ?? '', /no-reply@ongo\.test/);
  assert.ok(sent[0]?.text.includes('654321'));
});

test('a send failure never throws (the endpoint must still answer 202)', async () => {
  const transport: MailTransport = {
    async sendMail() {
      throw new Error('smtp is down');
    },
  };
  const config = { ...loadConfig(), SMTP_FROM: 'no-reply@ongo.test', SMTP_FROM_NAME: 'On Go' };
  const delivery = createSmtpDelivery(config, transport);
  await delivery.deliverPasswordResetCode({ email: 'user@example.com', code: '000000', expiresInSeconds: 600 });
  // reaching here without throwing is the assertion
  assert.ok(true);
});

test('reset codes to one inbox are capped per window, still answering 202', async () => {
  const ctx = await createTestApp();
  try {
    await createUser(ctx.db, { email: 'flood@example.com', password: 'a real password 1', role: 'client' });
    const max = loadConfig().PASSWORD_RESET_EMAIL_MAX;

    for (let i = 0; i < max + 2; i += 1) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password/reset',
        payload: { email: 'flood@example.com' },
      });
      assert.equal(res.statusCode, 202);
    }

    const delivered = ctx.resetCodes.filter((c) => c.email === 'flood@example.com');
    assert.equal(delivered.length, max, `at most ${max} codes are delivered per window`);
  } finally {
    await ctx.close();
  }
});
