// Where the name of a payment link leads, asked of the DNS when the link is saved and again each time it would be
// shown (src/server/routes-paylink.ts). The name check in src/lib/paylink.ts refuses names that say they are not
// public (localhost, router.home.arpa, 192.168.1.1.nip.io). This refuses names that look public and lead into a
// private network or to a special address, such as the signer's own router or this server's own machine, whatever
// the name is. It is asked again at the moment of showing, because what a name leads to can change after it was saved.
//
// What it cannot do: the signer's browser asks the DNS again by itself when it opens the link, and a name can be made
// to answer one thing to us and another to them a moment later. A Pay button only ever opens a page, with nothing
// of the signer's in it, and the account that set it has earned trust (payRefusal), so that is left as it is.
import { promises as dns } from 'node:dns';
import net from 'node:net';

/** The lookup in use. It sits on an object so a test can answer for its own names and hand every other name on. */
export const resolver = { lookup: (host: string): Promise<{ address: string; family: number }[]> => dns.lookup(host, { all: true, verbatim: true }) };
/** How long a lookup may take before the link counts as "could not be checked just now". */
export const LOOKUP_MS = 3000;

const v4 = (ip: string): number[] | null => {
  const p = ip.split('.');
  return p.length === 4 && p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255) ? p.map(Number) : null;
};
// Ranges that are not a site on the public internet: this network, private networks, shared address space of
// internet providers, the machine itself, link-local, protocol and documentation ranges, benchmarking, multicast,
// reserved and broadcast (the IANA special-purpose registry).
const V4_SPECIAL: [string, number][] = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]];
const num4 = (n: number[]) => n[0] * 2 ** 24 + n[1] * 2 ** 16 + n[2] * 2 ** 8 + n[3];
const special4 = (n: number[]) => V4_SPECIAL.some(([base, bits]) => Math.floor(num4(n) / 2 ** (32 - bits)) === Math.floor(num4(v4(base)!) / 2 ** (32 - bits)));

// An IPv6 address as its eight 16-bit groups, an IPv4 address written at its end included.
function v6(ip: string): number[] | null {
  let s = ip.split('%')[0].toLowerCase();
  if (!net.isIPv6(s)) return null;
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const q = v4(tail[1]);
    if (!q) return null;
    s = s.slice(0, -tail[1].length) + `${(q[0] * 256 + q[1]).toString(16)}:${(q[2] * 256 + q[3]).toString(16)}`;
  }
  const [head, rest] = s.split('::');
  const h = head ? head.split(':') : [];
  const r = rest === undefined ? null : rest ? rest.split(':') : [];
  const g = r === null ? h : [...h, ...Array(8 - h.length - r.length).fill('0'), ...r];
  return g.length === 8 ? g.map((x) => parseInt(x, 16)) : null;
}

/** Whether an address is anything other than a plain address on the public internet. Anything unreadable counts too. */
export function specialAddress(ip: string): boolean {
  const a = v4(ip);
  if (a) return special4(a);
  const g = v6(ip);
  if (!g) return true;
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const embedded = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
  // An IPv4 address written as IPv6 (::ffff:10.0.0.1), or translated for a network without IPv4 (64:ff9b::/96), is
  // judged as the IPv4 address it carries.
  if (zero(0, 5) && g[5] === 0xffff) return special4(embedded);
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return special4(embedded);
  // Only 2000::/3 is the public internet: that leaves out ::, ::1, unique-local fc00::/7, link-local fe80::/10 and
  // multicast. Inside it: protocol assignments and Teredo (2001::/23), documentation (2001:db8::/32 and 3fff::/20)
  // and 6to4 (2002::/16), which wraps an IPv4 address and is no longer used by any real site.
  if ((g[0] & 0xe000) !== 0x2000) return true;
  if (g[0] === 0x2001 && (g[1] < 0x200 || g[1] === 0xdb8)) return true;
  return g[0] === 0x2002 || (g[0] === 0x3fff && g[1] < 0x1000);
}

export type HostCheck = { ok: true } | { ok: false; why: 'none' | 'private' | 'later'; address?: string };

/**
 * Asks where a host name leads. "none": the name does not exist (a typo, or a site that is gone). "private": at least
 * one of its addresses is private or special, which is refused even when others are public, because the signer's
 * browser may pick that one. "later": the lookup failed or took longer than LOOKUP_MS, which says nothing about the
 * link: try again.
 */
export async function lookHost(host: string): Promise<HostCheck> {
  let timer: any;
  try {
    const answers = await Promise.race([resolver.lookup(host), new Promise<never>((_, no) => (timer = setTimeout(() => no(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), LOOKUP_MS)))]);
    if (!answers?.length) return { ok: false, why: 'none' };
    const odd = answers.find((x) => specialAddress(x.address));
    return odd ? { ok: false, why: 'private', address: odd.address } : { ok: true };
  } catch (err: any) {
    return { ok: false, why: err?.code === 'ENOTFOUND' || err?.code === 'ENODATA' ? 'none' : 'later' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What is wrong with a host that failed lookHost, in a sentence for the sender. Without a host (for an email, which
 * never carries any part of a payment link) it says "its address" instead.
 */
export function hostRefusal(check: HostCheck, host: string): string {
  if (check.ok) return '';
  const at = host ? `"${host}"` : 'its address';
  if (check.why === 'none') return `No site answers at ${at} right now, so a signer could not open it. Check the address with your payment provider.`;
  if (check.why === 'private') return `${host ? at : 'Its address'} leads to ${check.address}, which is an address inside a private network or kept for special uses, not a site on the public internet. A payment link has to lead to a public site.`;
  return `We could not check where ${at} leads just now. Try again in a minute.`;
}
