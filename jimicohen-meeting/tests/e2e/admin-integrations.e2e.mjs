/**
 * Integrations on a deployment where nothing is configured yet (the server runs without
 * DEV_MOCK_CREDS): every card starts empty, credentials are pasted in the browser, the status
 * badges follow, each "Send test" reaches the mocked provider, and no secret ever comes back.
 */
import { defineSuite } from './lib.mjs';
import { MONDAY, clearToasts, expectFieldProblem, expectToast, fieldProblem } from './admin-helpers.mjs';

// Made up here, at run time, in the shapes the real ones have.
const GOOGLE_ID = `1234567890-${'e2eclient'}abc123.apps.googleusercontent.com`;
const GOOGLE_SECRET = ['GOCSPX', 'e2eClientSecretValue', '0042'].join('-');
const RESEND_KEY = ['re', 'e2eResendKeyValue0042'].join('_');
const TWILIO_SID = `AC${'0123456789abcdef'.repeat(2)}`;
const TWILIO_TOKEN = `e2eTwilioAuthToken${'0042'.repeat(3)}`;
const TWILIO_NUMBER = '+15005550006';
const ANTHROPIC_KEY = ['sk', 'ant', 'e2eAnthropicKeyValue0042'].join('-');
const SECRETS = { GOOGLE_SECRET, RESEND_KEY, TWILIO_TOKEN, ANTHROPIC_KEY };
const OWNER_GOOGLE = 'jimi@example.com';
const MOBILE = '+14155552671';
/** The reminder channels the public site offers. (Its `email` flag says whether mail goes out: in development, to the mock outbox.) */
const reminderChannels = ({ sms, calls }) => ({ sms, calls });

export default defineSuite('admin-integrations', { mockCreds: false }, async (t) => {
  await t.scenario('integrations from nothing: paste credentials, test each one, remove them again', { reset: true }, async (s) => {
    await s.setClock(MONDAY);
    await s.setupAdmin({ timezone: 'UTC' });
    const page = await s.newPage({ signedIn: true, viewport: { width: 1440, height: 900 } });
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    // Every answer the browser gets from our API is kept, to prove no secret is ever sent back.
    const answers = [];
    page.on('response', (response) => {
      if (!response.url().includes('/meeting/api/')) return;
      response.text().then(
        (text) => answers.push({ url: response.url(), status: response.status(), text }),
        () => undefined,
      );
    });

    const card = (name) => page.getByRole('region', { name, exact: true });
    const badge = async (name) => (await card(name).locator('.ix-card__status').textContent()).trim();
    const open = async (name) => {
      const toggle = card(name).getByRole('button', { name, exact: true });
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    };
    const progress = async () => (await page.getByRole('navigation', { name: 'Connections' }).locator('.ix-progress__count').textContent()).replace(/\s+/g, ' ').trim();
    const status = async () => (await s.apiOk('GET', '/admin/integrations'));
    const result = (name) => card(name).locator('.x-result');

    await s.step('nothing is configured: four empty cards, nothing to test, nothing promised to visitors', async () => {
      await page.goto(s.url('/admin/integrations'));
      await page.getByRole('heading', { name: 'Integrations', level: 1 }).waitFor();
      s.expect(await progress(), 'connections').toBe('0 of 4 connected');
      s.expect(await badge('Google Calendar'), 'Google badge').toBe('Not set up');
      s.expect(await badge('Email'), 'email badge').toBe('Not sending yet');
      s.expect(await badge('Texts and reminder calls'), 'Twilio badge').toBe('Not set up');
      s.expect(await badge('Voice assistant'), 'assistant badge').toBe('Using the simple script');
      s.expect(await status(), 'integration status').toMatchObject({
        google: { configured: false, ownerConnected: false },
        twilio: { configured: false },
        anthropic: { configured: false },
        email: { resolved: 'none', resendConfigured: false, gmailAvailable: false, fromEmail: '' },
      });
      s.expect((await status()).twilio.accountSidMasked, 'a masked Twilio SID before anything is saved').toBe(undefined);
      s.expect(reminderChannels((await s.apiOk('GET', '/public/site')).features), 'reminder channels offered to visitors').toEqual({ sms: false, calls: false });

      await open('Google Calendar');
      s.expect(await card('Google Calendar').getByRole('button', { name: 'Connect Google Calendar' }).isDisabled(), 'connect before keys are saved').toBe(true);
      await open('Email');
      await open('Texts and reminder calls');
      s.expect(await card('Texts and reminder calls').getByRole('button', { name: 'Send test text' }).isDisabled(), 'test text before Twilio is saved').toBe(true);
      s.expect(await card('Texts and reminder calls').getByRole('button', { name: 'Call me' }).isDisabled(), 'test call before Twilio is saved').toBe(true);
      await open('Voice assistant');
      s.expect(await card('Voice assistant').getByRole('button', { name: 'Send test' }).isDisabled(), 'assistant test before a key is saved').toBe(true);
      await s.screenshot(page, 'integrations with nothing configured');

      // The same on Home: the checklist still has every connection open.
      const { checklist, warnings } = await s.apiOk('GET', '/admin/overview');
      s.expect(Object.fromEntries(checklist.map((c) => [c.key, c.done])), 'setup checklist').toMatchObject({ google: false, email: false, sms: false, assistant: false });
      // With no email and no calendar, a booking reaches nobody: Home says so too.
      s.expect(warnings.map((w) => w.key).sort(), 'warnings on Home').toEqual(['bookings_reach_nobody', 'google_not_connected', 'no_email', 'owner_no_email', 'twilio_missing']);
    });

    await s.step('a test email before anything is set up says plainly that it only reached the local outbox', async () => {
      // The dev server hands mail to its own outbox when no provider is set up (a deployment
      // answers "No email provider is set up yet." here). The result has to say so, not "sent".
      const email = card('Email');
      await email.getByLabel('Send it to').fill('owner@example.com');
      await email.getByRole('button', { name: 'Send test email' }).click();
      await result('Email').getByText('Test email sent to owner@example.com through the local test outbox.').waitFor();
      s.expect(await badge('Email'), 'email badge after the test').toBe('Not sending yet');
      await s.clearOutbox();
    });

    await s.step('the exact redirect address for Google is shown and can be copied', async () => {
      const google = card('Google Calendar');
      const address = google.getByRole('textbox', { name: 'Redirect address for Google' });
      s.expect(await address.inputValue(), 'redirect address').toBe(`${s.server.api}/google/callback`);
      s.expect((await status()).google.redirectUri, 'redirect address in the API').toBe(`${s.server.api}/google/callback`);
      await google.getByRole('button', { name: 'Copy', exact: true }).click();
      await s.eventually(async () => s.expect(await page.evaluate(() => navigator.clipboard.readText()), 'clipboard').toBe(`${s.server.api}/google/callback`));
    });

    await s.step('Google keys: bad values land on their fields, good ones are saved and masked', async () => {
      s.allowConsoleErrors(/status of 422/);
      const google = card('Google Calendar');
      const id = google.getByLabel('Client ID');
      const secret = google.getByLabel('Client secret');
      // Not a client ID at all: said at once, and it cannot be saved.
      await id.fill('my-google-client');
      await expectFieldProblem(s, id, 'This does not look like a client ID.', 'problem on the client ID');
      await secret.fill(GOOGLE_SECRET);
      s.expect(await google.getByRole('button', { name: 'Save keys' }).isDisabled(), 'save with a bad client ID').toBe(true);
      // A secret that is far too short: the server refuses, and the message lands on that field.
      await id.fill(GOOGLE_ID);
      await secret.fill('short');
      await google.getByRole('button', { name: 'Save keys' }).click();
      await expectFieldProblem(s, secret, 'This does not look like a Google client secret.', 'problem on the client secret');
      s.expect((await status()).google.configured, 'configured after a refused save').toBe(false);

      await secret.fill(GOOGLE_SECRET);
      s.expect(await secret.getAttribute('aria-invalid'), 'the problem goes away while typing').toBeNull();
      await google.getByRole('button', { name: 'Save keys' }).click();
      await expectToast(page, 'Google keys saved');
      await s.eventually(async () => s.expect(await badge('Google Calendar'), 'Google badge').toBe('Keys saved, not connected'));
      // Shown masked, never as typed. The boxes are gone, "Saved" rows took their place.
      await google.getByText('1234….apps.googleusercontent.com').waitFor();
      s.expect(await google.getByText('Saved', { exact: true }).count(), '"Saved" rows').toBe(2);
      s.expect(await google.getByLabel('Client secret').count(), 'secret boxes after saving').toBe(0);
      s.expect((await status()).google, 'Google status').toMatchObject({ configured: true, clientIdMasked: '1234….apps.googleusercontent.com', ownerConnected: false });
      await clearToasts(page);
    });

    await s.step('connect Google Calendar with the saved keys, then check the connection', async () => {
      const google = card('Google Calendar');
      const consent = await s.connectGoogle(page, OWNER_GOOGLE, 'UTC');
      await google.getByRole('button', { name: 'Connect Google Calendar' }).click();
      const outcome = await consent.done();
      s.expect(outcome.status, `connect result (${outcome.reason ?? 'no reason'})`).toBe('connected');
      // Google was asked with the client ID that was pasted here, and the redirect address shown above.
      s.expect(outcome.request, 'authorization request').toMatchObject({ clientId: GOOGLE_ID, redirectUri: `${s.server.api}/google/callback` });
      await expectToast(page, 'Google is connected');
      await google.getByText(`Connected as ${OWNER_GOOGLE}`).waitFor();
      s.expect(await badge('Google Calendar'), 'Google badge').toBe('Connected');
      s.expect(await progress(), 'connections').toBe('1 of 4 connected');
      s.expect(new URL(page.url()).search, 'the address bar is tidy again').toBe('');
      await clearToasts(page);

      await s.clearOutbox();
      await google.getByRole('button', { name: 'Check connection' }).click();
      await result('Google Calendar').getByText(`Connected as ${OWNER_GOOGLE}. Found 0 busy blocks in the next 7 days.`).waitFor();
      s.expect(await s.outbox({ kind: 'freebusy' }), 'free/busy calls made by the check').toMatchObject([{ service: 'google', account: OWNER_GOOGLE, ok: true }]);
    });

    await s.step('email: a bad key and a bad address land on their fields', async () => {
      const email = card('Email');
      await open('Email');
      const key = email.getByLabel('Resend API key');
      const from = email.getByLabel('From address');
      await from.fill('meetings-at-example');
      await expectFieldProblem(s, from, 'Please enter a full email address.', 'problem on the from address');
      s.expect(await email.getByRole('button', { name: 'Save email settings' }).isDisabled(), 'save with a bad address').toBe(true);
      await from.fill('meetings@example.com');
      await key.fill('abc');
      await email.getByRole('button', { name: 'Save email settings' }).click();
      await expectFieldProblem(s, key, 'This does not look like a Resend API key.', 'problem on the key');
      s.expect((await status()).email, 'email status after a refused save').toMatchObject({ resolved: 'none', resendConfigured: false });
    });

    await s.step('email: a key Resend refuses gives a clear test result, the right key sends', async () => {
      const email = card('Email');
      const key = email.getByLabel('Resend API key');
      await key.fill('invalid-resend-key-0042');
      await email.getByRole('button', { name: 'Save email settings' }).click();
      await expectToast(page, 'Email settings saved');
      await s.eventually(async () => s.expect(await badge('Email'), 'email badge').toBe('Sending with Resend'));
      s.expect(await progress(), 'connections').toBe('2 of 4 connected');
      await clearToasts(page);
      await email.getByLabel('Send it to').fill('owner@example.com');
      await email.getByRole('button', { name: 'Send test email' }).click();
      await result('Email').getByText(/^The test email was not sent\. Resend answered 403/).waitFor();
      s.expect(await result('Email').getAttribute('role'), 'a failed test is an alert').toBe('alert');

      // Replace it with the real one. The old value is never shown, only "Saved".
      await email.getByRole('button', { name: 'Replace' }).click();
      await email.getByLabel('Resend API key').fill(RESEND_KEY);
      await email.getByRole('button', { name: 'Save email settings' }).click();
      await expectToast(page, 'Email settings saved');
      await clearToasts(page);
      await s.clearOutbox();
      await email.getByRole('button', { name: 'Send test email' }).click();
      await result('Email').getByText('Test email sent to owner@example.com through Resend. It can take a minute to arrive.').waitFor();
      const [sent] = await s.outbox({ kind: 'email' });
      s.expect(sent, 'the test email').toMatchObject({ service: 'resend', ok: true, to: ['owner@example.com'], fromEmail: 'meetings@example.com', subject: 'Test email from Jimi Cohen' });
      s.expect((await status()).email, 'email status').toMatchObject({ setting: 'auto', resolved: 'resend', resendConfigured: true, fromEmail: 'meetings@example.com' });
      s.expect((await s.kv('site')).email.fromEmail, 'stored from address').toBe('meetings@example.com');
    });

    await s.step('Twilio: bad values land on their fields', async () => {
      const twilio = card('Texts and reminder calls');
      await open('Texts and reminder calls');
      const sid = twilio.getByLabel('Account SID');
      const token = twilio.getByLabel('Auth token');
      const number = twilio.getByLabel('Your Twilio number');
      await sid.fill('AC123');
      await expectFieldProblem(s, sid, 'An Account SID starts with AC and has 34 characters.', 'problem on the SID');
      // The browser takes what the server takes: AC and 32 letters or digits, not only hex.
      await sid.fill(`AC${'Zx9'.repeat(10)}Qq`);
      await s.eventually(async () => s.expect(await fieldProblem(sid), 'problem on a SID with letters beyond f').toBe(''));
      await number.fill('555 0100');
      await expectFieldProblem(s, number, 'Use the international format, for example +14155550123.', 'problem on the number');
      s.expect(await twilio.getByRole('button', { name: 'Save Twilio details' }).isDisabled(), 'save with bad values').toBe(true);
      await sid.fill(TWILIO_SID);
      await number.fill('+1 (500) 555-0006');
      await token.fill('too-short');
      await twilio.getByRole('button', { name: 'Save Twilio details' }).click();
      await expectFieldProblem(s, token, 'This does not look like a Twilio auth token.', 'problem on the token');
      s.expect((await status()).twilio, 'Twilio status after a refused save').toEqual({ configured: false, calls: false });
    });

    await s.step('Twilio: a token Twilio refuses gives a clear result, the right one texts and calls', async () => {
      const twilio = card('Texts and reminder calls');
      await twilio.getByLabel('Auth token').fill('invalid-twilio-token-0042');
      await twilio.getByRole('button', { name: 'Save Twilio details' }).click();
      await expectToast(page, 'Twilio saved');
      await s.eventually(async () => s.expect(await badge('Texts and reminder calls'), 'Twilio badge').toBe('Connected'));
      // The number was typed with spaces and brackets, and is kept in the international form.
      s.expect((await status()).twilio, 'Twilio status').toEqual({ configured: true, calls: true, accountSidMasked: 'AC01…cdef', fromNumber: TWILIO_NUMBER });
      s.expect(await twilio.getByLabel('Your Twilio number').inputValue(), 'number shown after saving').toBe(TWILIO_NUMBER);
      await twilio.getByText('AC01…cdef').waitFor();
      await clearToasts(page);
      await twilio.getByLabel('Your mobile number').fill(MOBILE);
      await twilio.getByRole('button', { name: 'Send test text' }).click();
      await result('Texts and reminder calls').getByText(/^The test text was not sent\./).waitFor();
      s.expect(await result('Texts and reminder calls').getAttribute('role'), 'a failed test is an alert').toBe('alert');

      await twilio.getByRole('button', { name: 'Replace' }).last().click();
      await twilio.getByLabel('Auth token').fill(TWILIO_TOKEN);
      await twilio.getByRole('button', { name: 'Save Twilio details' }).click();
      await expectToast(page, 'Twilio saved');
      await clearToasts(page);
      await s.clearOutbox();

      await twilio.getByRole('button', { name: 'Send test text' }).click();
      await result('Texts and reminder calls').getByText(`Test text sent to ${MOBILE}.`).waitFor();
      const [text] = await s.outbox({ kind: 'sms' });
      s.expect(text, 'the test text').toMatchObject({ service: 'twilio', ok: true, to: MOBILE, from: TWILIO_NUMBER, body: /texts are working/ });

      await twilio.getByRole('button', { name: 'Call me' }).click();
      await result('Texts and reminder calls').getByText(`Calling ${MOBILE} now. Ava will say it is a test call, and nothing will be changed.`).waitFor();
      const [placed] = await s.outbox({ kind: 'call' });
      s.expect(placed, 'the test call').toMatchObject({ service: 'twilio', ok: true, to: MOBILE, from: TWILIO_NUMBER });
      // Twilio fetches what to say from us: the assistant says who it is and that this is a test.
      const [call] = await s.calls();
      const spoken = await s.voice(call, 'start');
      s.expect(spoken.status, 'status of the voice webhook').toBe(200);
      s.expect(spoken.said, 'what the assistant says').toMatch(/Ava/);
      s.expect(spoken.said, 'what the assistant says').toMatch(/test/i);
      s.expect(await progress(), 'connections').toBe('3 of 4 connected');
      s.expect(reminderChannels((await s.apiOk('GET', '/public/site')).features), 'reminder channels offered to visitors').toEqual({ sms: true, calls: true });
    });

    await s.step('assistant: a bad key lands on its field, a good key and a model are saved and tested', async () => {
      const assistant = card('Voice assistant');
      await open('Voice assistant');
      const key = assistant.getByLabel('Anthropic API key');
      await key.fill('not-an-anthropic-key');
      await assistant.getByRole('button', { name: 'Save assistant settings' }).click();
      await expectFieldProblem(s, key, 'An Anthropic API key starts with sk-ant-.', 'problem on the key');
      s.expect((await status()).anthropic.configured, 'configured after a refused save').toBe(false);

      await key.fill(ANTHROPIC_KEY);
      await assistant.getByRole('combobox', { name: 'Model' }).selectOption({ label: 'Claude Sonnet 5.5 (quicker replies, lower cost)' });
      await assistant.getByRole('button', { name: 'Save assistant settings' }).click();
      await expectToast(page, 'Assistant settings saved');
      await s.eventually(async () => s.expect(await badge('Voice assistant'), 'assistant badge').toBe('Connected'));
      s.expect((await status()).anthropic, 'assistant status').toEqual({ configured: true, model: 'claude-sonnet-5-5' });
      s.expect((await s.kv('site')).assistant.model, 'stored model').toBe('claude-sonnet-5-5');
      s.expect(await progress(), 'connections').toBe('4 of 4 connected');
      await clearToasts(page);

      await s.clearOutbox();
      await assistant.getByRole('button', { name: 'Send test' }).click();
      await result('Voice assistant').getByText(/^The key works\. claude-sonnet-5-5 answered/).waitFor();
      const [asked] = await s.outbox({ kind: 'llm' });
      s.expect(asked, 'the test message to the model').toMatchObject({ service: 'anthropic', ok: true, model: 'claude-sonnet-5-5' });

      // A key Anthropic turns down gives a clear sentence, not a code.
      await s.failService('anthropic', { status: 401 });
      await assistant.getByRole('button', { name: 'Send test' }).click();
      await result('Voice assistant').getByText('Anthropic did not accept this key. Check that it was copied in full, then save it again.').waitFor();
      await s.clearFailures('anthropic');
    });

    await s.step('everything is stored sealed and shown masked: no secret came back in any answer', async () => {
      await page.reload();
      await page.getByRole('heading', { name: 'Integrations', level: 1 }).waitFor();
      s.expect(await progress(), 'connections after a reload').toBe('4 of 4 connected');
      for (const name of ['Google Calendar', 'Email', 'Texts and reminder calls', 'Voice assistant']) await open(name);
      await card('Google Calendar').getByRole('button', { name: 'Show the setup steps and keys' }).click();
      await card('Google Calendar').getByText('1234….apps.googleusercontent.com').waitFor();
      await card('Texts and reminder calls').getByText('AC01…cdef').waitFor();
      await page.waitForLoadState('networkidle');
      await s.screenshot(page, 'integrations with everything connected');

      const stored = await s.kv('secrets');
      s.expect(Object.keys(stored), 'what the secrets record holds').toEqual(['sealed']);
      const everything = JSON.stringify([await s.kv('secrets'), await s.kv('site'), await s.kv('hosts')]);
      const html = await page.content();
      const inputs = await page.locator('input').evaluateAll((nodes) => nodes.map((n) => n.value).join('\n'));
      s.expect(answers.length, 'API answers seen by the browser').toBeGreaterThan(20);
      for (const [name, value] of Object.entries(SECRETS)) {
        s.expect(everything.includes(value), `${name} readable in the store`).toBe(false);
        s.expect(html.includes(value), `${name} in the page`).toBe(false);
        s.expect(inputs.includes(value), `${name} in a form field`).toBe(false);
        const leaks = answers.filter((a) => a.text.includes(value)).map((a) => a.url);
        s.expect(leaks, `API answers that contain ${name}`).toEqual([]);
      }
      // The identifiers are only ever sent back masked.
      for (const [name, value] of Object.entries({ GOOGLE_ID, TWILIO_SID })) {
        const leaks = answers.filter((a) => a.text.includes(value)).map((a) => a.url);
        s.expect(leaks, `API answers that contain the full ${name}`).toEqual([]);
      }
      const direct = (await s.api('GET', '/admin/bootstrap')).text + (await s.api('GET', '/admin/integrations')).text;
      for (const [name, value] of Object.entries({ ...SECRETS, GOOGLE_ID, TWILIO_SID })) s.expect(direct.includes(value), `${name} in the dashboard data`).toBe(false);
    });

    await s.step('the rest of the dashboard knows: the checklist and the reminder channels', async () => {
      const { checklist, warnings } = await s.apiOk('GET', '/admin/overview');
      s.expect(Object.fromEntries(checklist.map((c) => [c.key, c.done])), 'setup checklist').toMatchObject({ google: true, email: true, sms: true, assistant: true });
      s.expect(warnings, 'warnings on Home').toEqual([]);
      await page.goto(s.url('/admin/event-types/evt_intro?tab=reminders'));
      const channels = page.locator('ul.adm-channels');
      await channels.getByText('Sent from meetings@example.com').waitFor();
      await channels.getByText(`Sent from ${TWILIO_NUMBER}`).waitFor();
      await channels.getByText(/^Ava calls between/).waitFor();
      s.expect(await channels.getByText('Ready', { exact: true }).count(), 'channels that are ready').toBe(3);
    });

    await s.step('Remove clears: the assistant key, Twilio, the Resend key', async () => {
      await page.goto(s.url('/admin/integrations'));
      for (const name of ['Email', 'Texts and reminder calls', 'Voice assistant']) await open(name);

      const assistant = card('Voice assistant');
      await assistant.getByRole('button', { name: 'Remove', exact: true }).click();
      await page.getByRole('dialog', { name: 'Remove the Anthropic key?' }).getByRole('button', { name: 'Remove key' }).click();
      await expectToast(page, 'Anthropic key removed');
      await s.eventually(async () => s.expect(await badge('Voice assistant'), 'assistant badge').toBe('Using the simple script'));
      s.expect(await assistant.getByRole('button', { name: 'Send test' }).isDisabled(), 'assistant test without a key').toBe(true);
      s.expect((await status()).anthropic.configured, 'assistant configured').toBe(false);

      const twilio = card('Texts and reminder calls');
      await twilio.getByRole('button', { name: 'Remove', exact: true }).click();
      await page.getByRole('dialog', { name: 'Remove Twilio?' }).getByRole('button', { name: 'Remove Twilio' }).click();
      await expectToast(page, 'Twilio removed');
      await s.eventually(async () => s.expect(await badge('Texts and reminder calls'), 'Twilio badge').toBe('Not set up'));
      s.expect((await status()).twilio, 'Twilio status').toEqual({ configured: false, calls: false });
      s.expect(await twilio.getByLabel('Your Twilio number').inputValue(), 'number box after removing').toBe('');
      s.expect(reminderChannels((await s.apiOk('GET', '/public/site')).features), 'reminder channels offered to visitors').toEqual({ sms: false, calls: false });

      const email = card('Email');
      await email.getByRole('button', { name: 'Remove', exact: true }).click();
      await page.getByRole('dialog', { name: 'Remove the Resend key?' }).getByRole('button', { name: 'Remove key' }).click();
      await expectToast(page, 'Resend key removed');
      await s.eventually(async () => s.expect(await badge('Email'), 'email badge').toBe('Not sending yet'));
      s.expect((await status()).email, 'email status').toMatchObject({ resolved: 'none', resendConfigured: false });
      s.expect(await progress(), 'connections').toBe('1 of 4 connected');
      await clearToasts(page);
    });

    await s.step('Google: disconnect, then remove the keys', async () => {
      const google = card('Google Calendar');
      await open('Google Calendar');
      await google.getByRole('button', { name: 'Disconnect' }).click();
      await page.getByRole('dialog', { name: 'Disconnect Google Calendar?' }).getByRole('button', { name: 'Disconnect' }).click();
      await expectToast(page, 'Google Calendar disconnected');
      await s.eventually(async () => s.expect(await badge('Google Calendar'), 'Google badge').toBe('Keys saved, not connected'));
      s.expect((await s.kv('hosts'))[0].google ?? null, "the owner's Google connection").toBeNull();
      s.expect((await s.outbox({ kind: 'revoke' })).length, 'grants handed back to Google').toBe(1);

      await google.getByRole('button', { name: 'Remove', exact: true }).click();
      await page.getByRole('dialog', { name: 'Remove the Google keys?' }).getByRole('button', { name: 'Remove keys' }).click();
      await expectToast(page, 'Google keys removed');
      await s.eventually(async () => s.expect(await badge('Google Calendar'), 'Google badge').toBe('Not set up'));
      s.expect(await google.getByRole('button', { name: 'Connect Google Calendar' }).isDisabled(), 'connect without keys').toBe(true);
      s.expect(await progress(), 'connections').toBe('0 of 4 connected');
      s.expect(await status(), 'status at the end').toMatchObject({ google: { configured: false, ownerConnected: false }, twilio: { configured: false }, anthropic: { configured: false }, email: { resolved: 'none', resendConfigured: false } });
      s.expect((await status()).google.clientIdMasked, 'masked client ID once the keys are gone').toBe(undefined);
    });
  });

  await t.scenario('a Google secret that Google refuses: the owner is told, and a new secret fixes it', { reset: true }, async (s) => {
    await s.setClock(MONDAY);
    await s.setupAdmin({ timezone: 'UTC' });
    const page = await s.newPage({ signedIn: true, viewport: { width: 1440, height: 900 } });
    const google = page.getByRole('region', { name: 'Google Calendar', exact: true });

    await s.step('keys with a secret Google does not accept are saved (we cannot know yet)', async () => {
      await page.goto(s.url('/admin/integrations'));
      await google.getByLabel('Client ID').fill(GOOGLE_ID);
      await google.getByLabel('Client secret').fill('invalid-client-secret');
      await google.getByRole('button', { name: 'Save keys' }).click();
      await expectToast(page, 'Google keys saved');
      await clearToasts(page);
    });

    await s.step('connecting fails with a reason, and nothing is stored as connected', async () => {
      const consent = await s.connectGoogle(page, OWNER_GOOGLE, 'UTC');
      await google.getByRole('button', { name: 'Connect Google Calendar' }).click();
      const outcome = await consent.done();
      s.expect(outcome.status, 'connect result').toBe('error');
      const toast = await expectToast(page, 'Google did not connect');
      s.expect((await toast.textContent()).length, 'the toast says why').toBeGreaterThan('Google did not connect'.length + 10);
      s.expect((await s.kv('hosts'))[0].google ?? null, "the owner's Google connection").toBeNull();
      s.expect((await google.locator('.ix-card__status').textContent()).trim(), 'Google badge').toBe('Keys saved, not connected');
      await s.screenshot(page, 'google refused the secret');
      await clearToasts(page);
    });

    await s.step('replacing the secret makes it work', async () => {
      await google.getByRole('button', { name: 'Replace' }).last().click();
      await google.getByLabel('Client secret').fill(GOOGLE_SECRET);
      await google.getByRole('button', { name: 'Save keys' }).click();
      await expectToast(page, 'Google keys saved');
      const consent = await s.connectGoogle(page, OWNER_GOOGLE, 'UTC');
      await google.getByRole('button', { name: 'Connect Google Calendar' }).click();
      s.expect((await consent.done()).status, 'connect result').toBe('connected');
      await google.getByText(`Connected as ${OWNER_GOOGLE}`).waitFor();
    });

    await s.step('the owner picks which calendars count, and where new meetings go', async () => {
      const TUESDAY_10 = '2026-11-17T10:00:00.000Z';
      const tuesday = async () => s.slots({ slug: 'intro', duration: 15, from: '2026-11-17T00:00:00.000Z', to: '2026-11-18T00:00:00.000Z' });
      const stored = async () => (await s.kv('hosts'))[0].google;
      // The main calendar is named after the account, with a "Main" tag behind it.
      const MAIN = /^jimi@example\.com/;
      const box = (name) => google.getByRole('checkbox', { name });
      const ticked = async (name, on) => box(name).and(page.locator(on ? ':checked' : ':not(:checked)')).waitFor();
      // Saved on its own: the tick moves once the server has answered.
      const toggle = async (name, on) => {
        const saved = page.waitForResponse((r) => r.url().endsWith('/api/admin/hosts/host_owner') && r.request().method() === 'PUT' && r.status() === 200);
        await box(name).click();
        await saved;
        await ticked(name, on);
      };

      // To begin with only the main calendar counts.
      await google.getByRole('heading', { name: 'Calendars to check for conflicts' }).waitFor();
      await ticked(MAIN, true);
      await ticked('Family', false);
      await ticked('Holidays in United States', false);
      s.expect(await stored(), 'calendar choice to begin with').toMatchObject({ busyCalendarIds: ['primary'], writeCalendarId: 'primary' });

      await toggle('Family', true);
      const familyId = (await stored()).busyCalendarIds.find((id) => id !== 'primary');
      s.expect(familyId, 'id of the Family calendar').toMatch(/^family.+@group\.calendar\.google\.com$/);
      // Something on the Family calendar now keeps that time off the booking page...
      await s.setGoogleBusy(OWNER_GOOGLE, [{ start: TUESDAY_10, end: '2026-11-17T11:00:00.000Z', calendarId: familyId }]);
      s.expect((await tuesday()).includes(TUESDAY_10), 'Tuesday 10:00 is offered while Family counts').toBe(false);
      // ...and stops doing so when the calendar is unticked.
      await toggle('Family', false);
      s.expect((await stored()).busyCalendarIds, 'calendars that count').toEqual(['primary']);
      await s.setGoogleBusy(OWNER_GOOGLE, [{ start: TUESDAY_10, end: '2026-11-17T11:00:00.000Z', calendarId: familyId }]);
      s.expect((await tuesday()).includes(TUESDAY_10), 'Tuesday 10:00 is offered once Family does not count').toBe(true);

      // With nothing ticked the card warns, because people could then book over other plans.
      await toggle(MAIN, false);
      s.expect((await stored()).busyCalendarIds, 'calendars that count').toEqual([]);
      await google.getByText('No calendar is checked, so people could book over your other plans. Tick at least one.').waitFor();
      await s.screenshot(page, 'google card with no calendar checked');
      await toggle(MAIN, true);
      s.expect(await google.getByText('No calendar is checked').count(), 'the warning once a calendar is ticked').toBe(0);
      // The main calendar counts again, whichever of its two names Google knows it by.
      await s.setGoogleBusy(OWNER_GOOGLE, [{ start: TUESDAY_10, end: '2026-11-17T11:00:00.000Z' }]);
      s.expect((await tuesday()).includes(TUESDAY_10), 'Tuesday 10:00 is offered while the main calendar is busy').toBe(false);
      await s.setGoogleBusy(OWNER_GOOGLE, []);

      // The read-only holiday calendar can be checked for busy time, but meetings cannot go there.
      const write = google.getByLabel('Add new meetings to');
      s.expect(await write.locator('option').allTextContents(), 'calendars meetings can go to').toEqual([`${OWNER_GOOGLE} (main)`, 'Family']);
      const saved = page.waitForResponse((r) => r.url().endsWith('/api/admin/hosts/host_owner') && r.request().method() === 'PUT' && r.status() === 200);
      await write.selectOption({ label: 'Family' });
      await saved;
      s.expect((await stored()).writeCalendarId, 'where new meetings go').toBe(familyId);
      await s.clearOutbox();
      const booked = await s.book({ slug: 'intro', start: TUESDAY_10, name: 'Mary Somerville', email: 'mary@example.com' });
      s.expect(booked.status, 'booking status').toBe(201);
      await s.settle();
      const [insert] = await s.outbox({ kind: 'calendar_insert' });
      s.expect(insert, 'the calendar event of the booking').toMatchObject({ ok: true, account: OWNER_GOOGLE });
      s.expect(decodeURIComponent(insert.url), 'the calendar it was written to').toContain(`/calendars/${familyId}/events`);
      // The choice is still there after a reload (a connected card starts closed, so open it).
      await page.reload();
      await google.getByRole('button', { name: 'Google Calendar', exact: true }).click();
      await ticked(MAIN, true);
      s.expect(await google.getByLabel('Add new meetings to').inputValue(), 'the chosen calendar after a reload').toBe(familyId);
    });

    await s.step('the person at Google presses Cancel: said plainly, nothing changes', async () => {
      await google.getByRole('button', { name: 'Disconnect' }).click();
      await page.getByRole('dialog', { name: 'Disconnect Google Calendar?' }).getByRole('button', { name: 'Disconnect' }).click();
      await expectToast(page, 'Google Calendar disconnected');
      await clearToasts(page);
      const consent = await s.connectGoogle(page, OWNER_GOOGLE, 'UTC', { deny: true });
      await google.getByRole('button', { name: 'Connect Google Calendar' }).click();
      s.expect((await consent.done()).status, 'connect result').toBe('error');
      const toast = await expectToast(page, 'Google did not connect');
      s.expect(await toast.textContent(), 'the reason').toContain('Google sign-in was cancelled, so nothing was connected.');
      s.expect((await s.kv('hosts'))[0].google ?? null, "the owner's Google connection").toBeNull();
      await clearToasts(page);
    });

    await s.step('connected while the consent screen is still in Testing: the card and the dashboard say when it ends', async () => {
      const consent = await s.connectGoogle(page, OWNER_GOOGLE, 'UTC', { flags: ['testing'] });
      await google.getByRole('button', { name: 'Connect Google Calendar' }).click();
      s.expect((await consent.done()).status, 'connect result').toBe('connected');
      await clearToasts(page);
      // Google gave the grant 7 days: Monday 16 November, 9:00, plus 604,799 seconds.
      s.expect((await s.kv('hosts'))[0].google.refreshExpiresAt, 'stored end').toBe('2026-11-23T08:59:59.000Z');
      const notice = google.getByText('This connection ends on Monday, November 23, 2026');
      await notice.waitFor();
      s.expect(await google.getByText('Publish the consent screen in Google Cloud (step 3 of the setup steps), then reconnect.').count(), 'what to do').toBe(1);
      await s.screenshot(page, 'google connection that ends in 7 days');
      const { warnings } = await s.apiOk('GET', '/admin/overview');
      const warning = warnings.find((w) => w.key === 'google_expiry_host_owner');
      s.expect(warning?.href, 'dashboard warning link').toBe('/admin/integrations#google');
      s.expect(warning?.message, 'dashboard warning').toContain('Your Google connection ends on Monday, November 23, 2026');

      // Published, and connected again: Google names no end, and nothing is said about one.
      const again = await s.connectGoogle(page, OWNER_GOOGLE, 'UTC');
      await google.getByRole('button', { name: 'Reconnect' }).first().click();
      s.expect((await again.done()).status, 'reconnect result').toBe('connected');
      await google.getByText(`Connected as ${OWNER_GOOGLE}`).waitFor();
      s.expect(await google.getByText('This connection ends on').count(), 'no end any more').toBe(0);
      s.expect('refreshExpiresAt' in (await s.kv('hosts'))[0].google, 'an end is stored').toBe(false);
      s.expect((await s.apiOk('GET', '/admin/overview')).warnings.some((w) => w.key.startsWith('google_expiry')), 'dashboard warning').toBe(false);
    });
  });

  await t.scenario('half working: texts with no number to call from, and Google keys removed while connected', { reset: true }, async (s) => {
    await s.setClock(MONDAY);
    await s.setupAdmin({ timezone: 'UTC' });
    const page = await s.newPage({ signedIn: true, viewport: { width: 1440, height: 900 } });
    const card = (name) => page.getByRole('region', { name, exact: true });
    const badge = async (name) => (await card(name).locator('.ix-card__status').textContent()).trim();
    const open = async (name) => {
      const toggle = card(name).getByRole('button', { name, exact: true });
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    };
    const status = async () => s.apiOk('GET', '/admin/integrations');
    const SERVICE_SID = `MG${'fedcba9876543210'.repeat(2)}`;

    await s.step('Twilio with only a Messaging Service: texts work, and calls are said to need a number', async () => {
      await page.goto(s.url('/admin/integrations'));
      await open('Texts and reminder calls');
      const twilio = card('Texts and reminder calls');
      await twilio.getByLabel('Account SID').fill(TWILIO_SID);
      await twilio.getByLabel('Auth token').fill(TWILIO_TOKEN);
      await twilio.getByLabel('Messaging Service SID').fill(SERVICE_SID);
      await twilio.getByRole('button', { name: 'Save Twilio details' }).click();
      await expectToast(page, 'Twilio saved');
      await s.eventually(async () => s.expect(await badge('Texts and reminder calls'), 'Twilio badge').toBe('Texts only'));
      await twilio.getByText('Add a phone number to place calls').waitFor();
      s.expect(await status(), 'Twilio status').toMatchObject({ twilio: { configured: true, calls: false, messagingServiceSid: SERVICE_SID } });
      await twilio.getByLabel('Your mobile number').fill(MOBILE);
      s.expect(await twilio.getByRole('button', { name: 'Send test text' }).isDisabled(), 'test text with a Messaging Service').toBe(false);
      s.expect(await twilio.getByRole('button', { name: 'Call me' }).isDisabled(), 'test call with no number').toBe(true);
      await twilio.getByText('A test call needs a Twilio phone number. Texts can be tested now.').waitFor();

      const { checklist, warnings } = await s.apiOk('GET', '/admin/overview');
      s.expect(checklist.find((c) => c.key === 'sms').done, 'texts and calls on the checklist').toBe(false);
      s.expect(warnings.find((w) => w.key === 'twilio_missing')?.message, 'the warning on Home').toMatch(/reminder calls need a Twilio phone number and none is saved/);

      await page.goto(s.url('/admin/event-types/evt_intro?tab=reminders'));
      const call = page.locator('ul.adm-channels li').filter({ hasText: 'AI phone call' });
      await call.getByText('Needs a Twilio phone number').waitFor();
      await call.getByRole('link', { name: 'Add a number' }).waitFor();
      const sms = page.locator('ul.adm-channels li').filter({ hasText: 'Text message' });
      await sms.getByText('Ready', { exact: true }).waitFor();
      s.expect(await call.getByText('Ready', { exact: true }).count(), 'calls shown as ready').toBe(0);
      await page.locator('ul.adm-rules').getByText('Calls need a Twilio phone number').first().waitFor();
      await s.screenshot(page, 'reminders with texts but no number to call from');
    });

    await s.step('Google keys removed while the calendar is connected: the card says it cannot work, and what to do', async () => {
      await s.apiOk('PUT', '/admin/integrations', { body: { google: { clientId: GOOGLE_ID, clientSecret: GOOGLE_SECRET } } });
      await s.connectGoogle(page, OWNER_GOOGLE, 'UTC', { gmail: true, start: { hostId: 'host_owner', gmail: true } });
      await clearToasts(page);
      await s.eventually(async () => s.expect(await badge('Google Calendar'), 'Google badge').toBe('Connected'));
      s.expect((await status()).email, 'email while Gmail works').toMatchObject({ resolved: 'gmail', gmailAvailable: true });

      const google = card('Google Calendar');
      await open('Google Calendar');
      await google.getByRole('button', { name: 'Show the setup steps and keys' }).click();
      await google.getByRole('button', { name: 'Remove', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Remove the Google keys?' });
      await dialog.getByText(/^Every connected Google Calendar stops working until you add the same keys again/).waitFor();
      await dialog.getByRole('button', { name: 'Remove keys' }).click();
      await expectToast(page, 'Google keys removed');
      await s.eventually(async () => s.expect(await badge('Google Calendar'), 'Google badge').toBe('Keys missing'));
      await google.getByText('Your calendar connection needs the Google keys').waitFor();
      await google.getByText(/Paste the same two keys again in step 5 below/).waitFor();
      await page.getByText('The Google keys are missing').waitFor();
      s.expect(await badge('Email'), 'email badge').toBe('Gmail cannot send');
      s.expect((await status()).email, 'email without the keys').toMatchObject({ resolved: 'none', gmailAvailable: false, gmailProblem: 'keys_missing' });

      const { checklist, warnings } = await s.apiOk('GET', '/admin/overview');
      s.expect(Object.fromEntries(checklist.map((c) => [c.key, c.done])), 'setup checklist').toMatchObject({ google: false, email: false });
      const keys = warnings.map((w) => w.key);
      s.expect(keys, 'warnings on Home').toContain('google_keys_missing');
      s.expect(keys, 'warnings on Home').not.toContain('no_email');
      // No times are offered, so Home must not say people "can book" these meetings.
      s.expect(keys, 'warnings on Home').not.toContain('bookings_reach_nobody');
      s.expect(warnings.find((w) => w.key === 'google_keys_missing').message, 'the warning').toContain('No emails are going out either, because they are sent from your Gmail.');
      await s.screenshot(page, 'google keys removed while connected');
      await clearToasts(page);
    });

    await s.step('pasting the same keys again brings the connection and Gmail back', async () => {
      const google = card('Google Calendar');
      await google.getByLabel('Client ID').fill(GOOGLE_ID);
      await google.getByLabel('Client secret').fill(GOOGLE_SECRET);
      await google.getByRole('button', { name: 'Save keys' }).click();
      await expectToast(page, 'Google keys saved');
      await s.eventually(async () => s.expect(await badge('Google Calendar'), 'Google badge').toBe('Connected'));
      s.expect(await badge('Email'), 'email badge').toBe('Sending from Gmail');
      s.expect((await page.getByText('The Google keys are missing').count()), 'the page notice').toBe(0);
    });
  });
});
