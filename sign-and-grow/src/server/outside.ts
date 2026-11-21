// Holding the server to OUTSIDE_CALLS (the list and the rules are in src/lib/outside.ts). Installed once, first thing,
// from src/instrumentation.ts. In mode all it changes nothing. In mode listed or none:
//   - globalThis.fetch refuses a host that is not allowed, before anything is sent, with an error that names the host
//     and the setting. Every outside call made with fetch (payments, sign-in, text messages, time-stamps, the help
//     chat's model, the converter, the SNS confirmation) goes through it.
//   - net.connect, net.createConnection, tls.connect and the plain http agent do the same for connections that do not
//     use fetch: the mail relay (nodemailer opens its own sockets) and webhooks (node:http and node:https). A
//     connection to an internet address with no name is allowed only when that address came from looking up a name
//     that is allowed (nodemailer looks the relay up itself and then connects to the address), or when the address is
//     listed itself.
//   - A refused host is written to the server log once an hour, not once a call.
// It is a second line of defence. It cannot see what a program the server starts does (LibreOffice), or native code.
// Egress is stopped for real in the network around the server: deploy/helm/growsigning has a NetworkPolicy for it.
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import { outsidePolicy, hostAllowed, refusalWords, normalHost, onList, type OutsidePolicy } from '../lib/outside.ts';

const g = globalThis as any;

export class OutsideRefused extends Error {
  host: string;
  constructor(host: string, words: string) {
    super(words);
    this.name = 'OutsideRefused';
    this.host = host;
  }
}

const HOUR = 3600_000;
/** Writes a refused host to the log at most once an hour. Answers whether it wrote. */
export function logRefusal(host: string, words: string, at = Date.now()): boolean {
  const seen: Map<string, number> = (g.__sgOutsideLogged ??= new Map());
  const last = seen.get(host);
  if (last !== undefined && at - last < HOUR) return false;
  seen.set(host, at);
  console.error(`[outside] Refused a connection. ${words}${last !== undefined ? '' : ' (said once an hour for each host)'}`);
  return true;
}

// Internet addresses that a lookup of an allowed name returned, kept ten minutes: nodemailer connects to the address
// it looked up, and that connection must count as the name's.
const LOOKED_UP_MS = 10 * 60_000;
function noteAddresses(name: string, answer: any) {
  const p: OutsidePolicy | undefined = g.__sgOutsidePolicy;
  if (!p || !hostAllowed(p, name)) return;
  const seen: Map<string, number> = (g.__sgOutsideAddrs ??= new Map());
  const until = Date.now() + LOOKED_UP_MS;
  const list = Array.isArray(answer) ? answer : [answer];
  for (const a of list) {
    const ip = typeof a === 'string' ? a : a?.address;
    if (typeof ip === 'string' && net.isIP(ip)) seen.set(normalHost(ip), until);
  }
}
const lookedUp = (ip: string) => {
  const until = g.__sgOutsideAddrs?.get(normalHost(ip));
  return typeof until === 'number' && until > Date.now();
};

/** Whether a connection to this host (and the name it says it is for, with TLS) may be opened now. */
export function connectAllowed(p: OutsidePolicy, host: string | undefined, servername?: string | false): boolean {
  if (p.mode === 'all') return true;
  const h = normalHost(host || 'localhost');
  if (servername && !net.isIP(String(servername))) return hostAllowed(p, String(servername)) && (net.isIP(h) ? true : hostAllowed(p, h));
  if (hostAllowed(p, h)) return true;
  return !!net.isIP(h) && (lookedUp(h) || onList(p.allow, h));
}

// The arguments of net.connect and tls.connect come in several shapes: (options), (port, host), (path), with a
// callback at the end. Only the host and the TLS server name matter here; a local socket path is never outside.
function target(args: any[]): { host?: string; servername?: string | false; local: boolean } {
  const [a, b] = args;
  if (a && typeof a === 'object') return { host: a.host ?? a.hostname, servername: a.servername, local: typeof a.path === 'string' };
  if (typeof a === 'string' && !/^\d+$/.test(a)) return { local: true };
  return { host: typeof b === 'string' ? b : undefined, local: false };
}

// A refused connection is a socket that fails at once with the reason, the way a connection the network refused
// fails: every caller already handles that.
function refusedSocket(host: string, words: string): net.Socket {
  const s = new net.Socket();
  process.nextTick(() => s.destroy(Object.assign(new OutsideRefused(host, words), { code: 'EOUTSIDE' })));
  return s;
}

function guard<F extends (...a: any[]) => any>(orig: F, p: OutsidePolicy): F {
  return function (this: any, ...args: any[]) {
    const t = target(args);
    if (!t.local && !connectAllowed(p, t.host, t.servername)) {
      const host = normalHost(t.servername && !net.isIP(String(t.servername)) ? String(t.servername) : t.host || '?');
      const words = refusalWords(p, host);
      logRefusal(host, words);
      return refusedSocket(host, words);
    }
    return orig.apply(this, args);
  } as F;
}

function hostOfRequest(input: any): string {
  try {
    const u = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input?.url);
    return normalHost(u.hostname);
  } catch {
    return '';
  }
}

/**
 * Installs the guard for the settings in `env`. Answers a function that takes it off again (for the tests). In mode
 * all it installs nothing and answers a function that does nothing.
 */
export function installOutsideGuard(env: Record<string, string | undefined> = process.env): () => void {
  const p = outsidePolicy(env);
  if (p.mode === 'all') return () => {};
  if (g.__sgOutsideUndo) g.__sgOutsideUndo();
  g.__sgOutsidePolicy = p;
  const saved = {
    fetch: globalThis.fetch, netConnect: net.connect, netCreate: net.createConnection, tlsConnect: tls.connect,
    agentCreate: http.Agent.prototype.createConnection, lookup: dns.lookup, plookup: dns.promises.lookup,
    r4: dns.Resolver.prototype.resolve4, r6: dns.Resolver.prototype.resolve6,
  };
  const orig = saved.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const host = hostOfRequest(input);
    if (host && !hostAllowed(p, host)) {
      const words = refusalWords(p, host);
      logRefusal(host, words);
      throw new OutsideRefused(host, words);
    }
    return orig(input, init);
  }) as typeof fetch;
  (net as any).connect = guard(saved.netConnect, p);
  (net as any).createConnection = guard(saved.netCreate, p);
  (tls as any).connect = guard(saved.tlsConnect, p);
  // The plain http agent took its own copy of net.createConnection when it was loaded.
  http.Agent.prototype.createConnection = guard(saved.agentCreate as any, p);
  // Lookups of allowed names: their answers count as those names (see noteAddresses).
  (dns as any).lookup = function (host: string, ...rest: any[]) {
    const cb = rest[rest.length - 1];
    if (typeof cb !== 'function') return (saved.lookup as any).call(this, host, ...rest);
    return (saved.lookup as any).call(this, host, ...rest.slice(0, -1), (err: any, addr: any, fam: any) => (err || noteAddresses(host, addr), cb(err, addr, fam)));
  };
  (dns.promises as any).lookup = async (host: string, opts?: any) => {
    const r = await saved.plookup(host, opts);
    noteAddresses(host, r);
    return r;
  };
  for (const [k, f] of [['resolve4', saved.r4], ['resolve6', saved.r6]] as const)
    (dns.Resolver.prototype as any)[k] = function (this: any, host: string, ...rest: any[]) {
      const cb = rest[rest.length - 1];
      if (typeof cb !== 'function') return (f as any).call(this, host, ...rest);
      return (f as any).call(this, host, ...rest.slice(0, -1), (err: any, addrs: any) => (err || noteAddresses(host, addrs), cb(err, addrs)));
    };
  syncBuiltinESMExports();
  const undo = () => {
    globalThis.fetch = saved.fetch;
    (net as any).connect = saved.netConnect;
    (net as any).createConnection = saved.netCreate;
    (tls as any).connect = saved.tlsConnect;
    http.Agent.prototype.createConnection = saved.agentCreate;
    (dns as any).lookup = saved.lookup;
    (dns.promises as any).lookup = saved.plookup;
    dns.Resolver.prototype.resolve4 = saved.r4;
    dns.Resolver.prototype.resolve6 = saved.r6;
    syncBuiltinESMExports();
    if (g.__sgOutsideUndo === undo) g.__sgOutsideUndo = null;
    g.__sgOutsidePolicy = undefined;
  };
  g.__sgOutsideUndo = undo;
  return undo;
}

/** Whether the guard is installed in this process, and in which mode. */
export const guardMode = (): string => g.__sgOutsidePolicy?.mode || 'off';
