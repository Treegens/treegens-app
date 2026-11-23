// The automatic Adobe Acrobat check, as part of /api/openapi.json (routes-acrobat.ts, acrobat.ts). Kept apart so the
// main description stays readable; openapi.ts spreads it into its paths and adds the acrobatToken scheme. Both are
// left out while ACROBAT_CHECK_TOKEN is unset, so the public description does not show a feature that is off.
import { acrobatToken, ACROBAT_SAMPLES_PER_DAY, ACROBAT_FAIL_ALERTS_PER_DAY, ACROBAT_SCREENSHOT_PIXELS, ACROBAT_TOKEN_MIN, ACROBAT_PER_HOUR, ACROBAT_BODY_MAX, ACROBAT_SCREENSHOT_MAX, ACROBAT_COLOURS, ACROBAT_PASS_WORDS, ACROBAT_KEEP, ACROBAT_REPORT_HOURS, ACROBAT_SILENT_DAYS, ACROBAT_EVERY_DAYS } from './acrobat.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const str = { type: 'string' };
const nstr = { type: 'string', nullable: true };
const bool = { type: 'boolean' };
const OPS = `For the people who run this server only, never for customers. Without ACROBAT_CHECK_TOKEN set (at least ${ACROBAT_TOKEN_MIN} characters), and without "Authorization: Bearer <that token>" (never in the query string), it answers 404 exactly like a route that does not exist, however often it is tried.`;
const LIMIT = `${ACROBAT_PER_HOUR} calls an hour from one address with the right token; past that, 429. Calls without it never count towards this.`;
const COVERS = 'The sample\'s only signature is a document time stamp, which is what a completed document carries on a server without a seal. With a server seal on, completed documents also carry the seal, and this check does not test how Acrobat shows that.';

export const ACROBAT_SCHEME = {
  type: 'http', scheme: 'bearer',
  description: 'For /ops/acrobat-check only: the value of ACROBAT_CHECK_TOKEN on the server, as "Authorization: Bearer <token>". It is not an API key and an API key does not work there.',
};

const check = {
  type: 'object',
  properties: {
    id: str, created_at: str, tsa_host: str, tsa_name: nstr, tsa_time: nstr, trusted: bool, forced: bool, reported_at: nstr,
    verdict: { type: 'string', enum: ['pass', 'fail', 'waiting', 'missed'] }, banner_text: nstr, banner_colour: nstr,
    panel_lines: { type: 'array', items: str }, acrobat_version: nstr, os: nstr, notes: nstr, screenshot: bool, alerted: bool,
  },
};

export const acrobatPaths = () => (!acrobatToken() ? {} : {
  '/ops/acrobat-check/sample': {
    get: {
      tags: ['Operator'], summary: 'A sample PDF for the automatic Adobe Acrobat check (operators only, bearer token)', security: [{ acrobatToken: [] }],
      description: `${OPS} Makes a new one-page PDF in memory that says it is a GrowSigning Acrobat check (the date, a new check id, the time-stamp services in use, and "This file holds no customer data"), adds one document time stamp exactly as a completed document without a seal gets one (TSA_URL, TSA_TRUST), keeps a small row about it, and sends it as an attachment named growsigning-acrobat-check-<id>.pdf. ${COVERS} Headers: X-Check-Id (report on it with POST /ops/acrobat-check/result), X-Tsa-Host (the service that answered), X-Tsa-Trusted ("true" when that service's certificate leads to one in TSA_TRUST) and X-Tsa-Time. "tsa": ask only the service in TSA_URL with this host (to test the backup service too); any other host is refused with 400, code "tsa_not_listed". When no service gives a time stamp: 503, code "tsa_down", with the reason, and the operators are emailed and get an item in the queue once a day (once for all the services, and once for each service named with "tsa"). At most ${ACROBAT_SAMPLES_PER_DAY} samples are made in any 24 hours from all addresses together; past that, 429, code "too_many_samples". ${LIMIT}`,
      parameters: [{ name: 'tsa', in: 'query', required: false, schema: str, description: 'The host of one service in TSA_URL, for example timestamp.digicert.com.' }],
      responses: {
        200: { description: 'The sample PDF', headers: { 'X-Check-Id': { schema: str }, 'X-Tsa-Host': { schema: str }, 'X-Tsa-Trusted': { schema: { type: 'string', enum: ['true', 'false'] } }, 'X-Tsa-Time': { schema: str } }, content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } },
        400: err, 404: err, 429: err, 503: err, default: err,
      },
    },
  },
  '/ops/acrobat-check/result': {
    post: {
      tags: ['Operator'], summary: 'What Adobe Acrobat showed for a sample (operators only, bearer token)', security: [{ acrobatToken: [] }],
      description: `${OPS} Each check id is reported once (409, code "already_reported", after that); an id this server does not hold answers 404, code "unknown_check". The server decides: "pass" only when "banner_text" contains "${ACROBAT_PASS_WORDS}" (in any case), "banner_colour" is "blue", neither the bar nor any panel line holds one of Acrobat's warning words (invalid, problem, unknown, revoked, altered, corrupted, untrusted, not trusted, could not be verified, error), and the server itself could check the sample's time stamp against TSA_TRUST. Anything else is "fail", and the operators are told at once by email and in the queue, with the bar, the panel lines, the time-stamp service and a link to the check on the operator page ("alerted": true); after ${ACROBAT_FAIL_ALERTS_PER_DAY} fail alerts in one UTC day, later fails that day are kept and shown on the operator page only ("alerted": false). "why" lists what made it fail. "late" is true when the report came after the missed-check alarm for it; it still counts. A field that is not right is refused with 400 and "field", and the check stays open. "screenshot_png_base64" must decode to a whole PNG file of at most ${ACROBAT_SCREENSHOT_MAX} bytes, 8 bits per colour without a palette, not interlaced, and at most ${ACROBAT_SCREENSHOT_PIXELS} pixels; only its pixels are kept, written again, in the server's file store. A body over ${ACROBAT_BODY_MAX} bytes is refused with 413. The last ${ACROBAT_KEEP} checks are kept. A sample fetched and not reported on within ${ACROBAT_REPORT_HOURS} hours, and no check at all for more than ${ACROBAT_SILENT_DAYS} days after the first one (one is expected every ${ACROBAT_EVERY_DAYS} days), are told to the operators once by the timer. ${LIMIT}`,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object', required: ['check_id', 'banner_text', 'banner_colour', 'panel_lines', 'acrobat_version', 'os'],
              properties: {
                check_id: { ...str, description: 'The X-Check-Id of the sample.' },
                banner_text: { ...str, maxLength: 500, description: 'The words in the bar at the top of the document, as Acrobat shows them. Empty when there is no bar.' },
                banner_colour: { type: 'string', enum: [...ACROBAT_COLOURS] },
                panel_lines: { type: 'array', maxItems: 60, items: { ...str, maxLength: 500 }, description: 'The lines of the Signature panel and of Signature Properties, one per entry.' },
                acrobat_version: { ...str, maxLength: 100 }, os: { ...str, maxLength: 100 },
                screenshot_png_base64: { ...str, description: 'Optional. A PNG of the Acrobat window, base64 (a "data:image/png;base64," start is allowed).' },
                notes: { ...str, maxLength: 2000 },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'fail'] }, alerted: bool, why: { type: 'array', items: str }, late: bool } } } } },
        400: err, 404: err, 409: err, 413: err, 429: err, default: err,
      },
    },
  },
  '/operator/acrobat-check': {
    get: {
      tags: ['Operator'], summary: 'The Adobe Acrobat check card',
      description: 'Only for a confirmed login listed in OPERATOR_EMAILS; anyone else gets 404. "on": whether ACROBAT_CHECK_TOKEN is set (the token itself is never shown). "seal_on": whether completed documents carry a server seal, which this check does not cover. "last": the latest check that was reported; "checks": the last 10, newest first ("waiting" or "missed" until reported); "next_expected_at": the newest check plus the days between checks; "alarm_at": when the operators are told that no check came.',
      responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { on: bool, seal_on: bool, tsa_hosts: { type: 'array', items: str }, every_days: { type: 'integer' }, first_at: nstr, next_expected_at: nstr, alarm_at: nstr, last: { ...check, nullable: true }, checks: { type: 'array', items: check } } } } } }, default: err },
    },
  },
  '/operator/acrobat-check/{id}/screenshot': {
    parameters: [{ name: 'id', in: 'path', required: true, schema: str }],
    get: {
      tags: ['Operator'], summary: 'The screenshot of a check',
      description: 'Only for a confirmed login listed in OPERATOR_EMAILS; anyone else, and a check without a screenshot, gets 404.',
      responses: { 200: { description: 'The PNG', content: { 'image/png': { schema: { type: 'string', format: 'binary' } } } }, default: err },
    },
  },
});
