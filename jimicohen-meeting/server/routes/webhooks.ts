/**
 * Provider webhooks. These are form posts from Twilio's servers, not from a browser: they carry no
 * Origin and no X-Requested-With header, so the CSRF check of the browser-facing routes must not be
 * applied here. What proves a request is genuine is its X-Twilio-Signature, which the handlers
 * verify themselves against the public URL (403 when it is missing or wrong).
 */
import { registerBookingJobHandlers } from '../lib/booking';
import { HttpError, route, type Route } from '../lib/http';
import { handleInboundSms, handleSmsStatus } from '../lib/sms';
import { handleVoiceWebhook } from '../lib/voice';

// A call can end with a queued message being sent straight away: the job runner needs its handlers.
registerBookingJobHandlers();

type VoiceStep = 'start' | 'turn' | 'status' | 'amd';
const VOICE_STEPS: readonly string[] = ['start', 'turn', 'status', 'amd'];

export const routes: Route[] = [
  route('POST', '/twilio/voice/:step', async ({ ctx, req, params }) => {
    if (!VOICE_STEPS.includes(params.step)) throw new HttpError(404, 'not_found', 'Not found.');
    return handleVoiceWebhook(ctx, req, params.step as VoiceStep);
  }),

  route('POST', '/twilio/sms', async ({ ctx, req }) => handleInboundSms(ctx, req)),

  // What became of a text we sent: Twilio reports it here after the carrier has had its say.
  route('POST', '/twilio/sms/status', async ({ ctx, req }) => handleSmsStatus(ctx, req)),
];
