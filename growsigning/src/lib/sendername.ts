// The name of the account next to the name of the person who sent a document. Every new account is called
// "<Person>'s workspace", which says the person's name a second time and nothing else. The signing page and the
// invitation email name the account only when its name says more than the person's does.

/** The account's name when it adds something to the sender's own name, else ''. */
export function orgOf(account: unknown, sender: unknown): string {
  const org = String(account ?? '').trim();
  const person = String(sender ?? '').trim().toLowerCase();
  if (!org || /['’]s workspace$/i.test(org)) return '';
  if (person && org.toLowerCase().includes(person)) return '';
  return org;
}
