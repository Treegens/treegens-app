// The sender screen inside a customer's app (app/embed/send) has no cookie: every request it makes, through api() or
// straight to a file (the PDF viewer, uploads), carries the token its one-time link gave it (src/server/embed.ts).
let screenToken = '';
export const setScreenToken = (t: string) => void (screenToken = t);
/** The header for a request of the sender screen; nothing anywhere else. */
export const screenHeaders = (): Record<string, string> => (screenToken ? { authorization: `Bearer ${screenToken}` } : {});
