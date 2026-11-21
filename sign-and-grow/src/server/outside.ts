// Holding the server to OUTSIDE_CALLS (the list and the rules are in src/lib/outside.ts). Installed once, first thing,
// from src/instrumentation.ts. In mode all it changes nothing. In mode listed or none:
//   - globalThis.fetch refuses a host that is not allowed, before anything is sent, with an error that names the host
//     and the setting. Every outside call made with fetch (payments, sign-in, text messages, time-stamps, the help
//     chat's model, the converter, the SNS confirmation) goes through it.
//   - Every TCP and TLS connection Node opens passes net.Socket.prototype.connect, so that is where the guard stands:
//     net.connect, new net.Socket().connect, tls.connect, http, https and http2 all end there, whatever shape their
//     arguments have. That covers the mail relay (nodemailer opens its own sockets) and webhooks (node:http and
//     node:https). A connection to an internet address with no name is allowed only when that address came from
//     looking up a name that is allowed (nodemailer looks the relay up itself and then connects to the address), or
//     when the address is listed itself. A TLS server name that is allowed does not make an address allowed.
//   - UDP (node:dgram send and connect) is held the same way. The server itself sends none.
//   - In mode none, a name that is not allowed is not looked up either (dns.lookup, dns.resolve* and their promise
//     and Resolver forms), so the name does not leave the server in a question to the DNS. In mode listed names are
//     still looked up: a payment link is checked by asking where its name leads (src/server/paydns.ts), and that
//     asks the DNS without ever connecting to the name.
//   - A refused host is written to the server log once an hour, not once a call.
// It is a second line of defence. It cannot see what a program the server starts does (LibreOffice), or native code.
// Egress is stopped for real in the network around the server: deploy/helm/growsigning has a NetworkPolicy for it.
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import dns from 'node:dns';
import dgram from 'node:dgram';
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
  // A TLS server name that is allowed does not open the door to any address: the address itself must be allowed too.
  if (servername && !net.isIP(String(servername)) && !hostAllowed(p, String(servername))) return false;
  if (hostAllowed(p, h)) return true;
  return !!net.isIP(h) && (lookedUp(h) || onList(p.allow, h));
}

// The arguments of a connect call come in several shapes: (options), (port, host), (port, options), (port, host,
// options), (path), Node's own already-sorted pair [options, callback], each with a callback at the end. Only the
// host and the TLS server name matter here; a local socket path is never outside.
function target(args: any[]): { host?: string; servername?: string | false; local: boolean } {
  if (args.length && Array.isArray(args[0])) args = args[0];
  const [a, b] = args;
  if (a && typeof a === 'object') return { host: a.host ?? a.hostname, servername: a.servername, local: typeof a.path === 'string' };
  if (typeof a === 'string' && !/^\d+$/.test(a)) return { local: true };
  const o = args.find((x, i) => i > 0 && x && typeof x === 'object');
  return { host: typeof b === 'string' ? b : o?.host ?? o?.hostname, servername: o?.servername, local: false };
}

// A refused connection is a socket that fails at once with the reason, the way a connection the network refused
// fails: every caller already handles that.
function refusedSocket(host: string, words: string): net.Socket {
  const s = new net.Socket();
  // As a socket that is still connecting, so nobody takes it for connected (http2 would) before it fails.
  (s as any).connecting = true;
  process.nextTick(() => (((s as any).connecting = false), s.destroy(Object.assign(new OutsideRefused(host, words), { code: 'EOUTSIDE' }))));
  return s;
}

function guard<F extends (...a: any[]) => any>(orig: F, p: OutsidePolicy): F {
  return function (this: any, ...args: any[]) {
    const t = target(args);
    if (!t.local && !connectAllowed(p, t.host, t.servername)) {
      // Named in the refusal: the server name when that is what is not allowed, otherwise the host or address.
      const host = normalHost(t.servername && !net.isIP(String(t.servername)) && !hostAllowed(p, String(t.servername)) ? String(t.servername) : t.host || '?');
      const words = refusalWords(p, host);
      logRefusal(host, words);
      return refusedSocket(host, words);
    }
    return orig.apply(this, args);
  } as F;
}

// Every way node:dns asks about a name, on the module, its promises and both kinds of Resolver.
const DNS_CALLS = ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa', 'resolveTxt', 'reverse'];

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
  g.__sgOutsideAddrs = new Map(); // addresses looked up under earlier settings count for nothing now
  const saved = {
    fetch: globalThis.fetch, netConnect: net.connect, netCreate: net.createConnection, tlsConnect: tls.connect,
    agentCreate: http.Agent.prototype.createConnection,
    sockConnect: net.Socket.prototype.connect, udpSend: dgram.Socket.prototype.send, udpConnect: dgram.Socket.prototype.connect,
  };
  const refuse = (host: string | undefined, servername?: string | false) => {
    const h = normalHost(servername && !net.isIP(String(servername)) && !hostAllowed(p, String(servername)) ? String(servername) : host || '?');
    const words = refusalWords(p, h);
    logRefusal(h, words);
    return Object.assign(new OutsideRefused(h, words), { code: 'EOUTSIDE' });
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
  // Where every TCP and TLS connection ends up, whichever function started it. A refused one fails at once with the
  // reason, the way a connection the network refused fails.
  net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
    const t = target(args);
    if (!t.local && !connectAllowed(p, t.host)) {
      const err = refuse(t.host);
      (this as any).connecting = true; // see refusedSocket
      process.nextTick(() => (((this as any).connecting = false), this.destroy(err)));
      return this;
    }
    return (saved.sockConnect as any).apply(this, args);
  } as any;
  // UDP. send(msg, [offset, length,] [port], [address], [callback]) and connect(port, [address], [callback]): the
  // address is the first text after the first argument. Without one it is this machine, or where connect() led.
  const udp = (orig: Function, from: number) => function (this: dgram.Socket, ...args: any[]) {
    const host = args.slice(from).find((x) => typeof x === 'string');
    if (host !== undefined && !connectAllowed(p, host)) {
      const err = refuse(host);
      const cb = args[args.length - 1];
      process.nextTick(() => (typeof cb === 'function' ? cb(err) : this.emit('error', err)));
      return;
    }
    return orig.apply(this, args);
  };
  dgram.Socket.prototype.send = udp(saved.udpSend, 1) as any;
  dgram.Socket.prototype.connect = udp(saved.udpConnect, 1) as any;
  // Looking names up. The answers for an allowed name count as that name (see noteAddresses). In mode none a name
  // that is not allowed is not asked about at all; an address written out asks nobody, except to be turned back
  // into a name (reverse).
  const mayAsk = (fn: string, name: any) => p.mode !== 'none' || typeof name !== 'string' || (fn === 'reverse' ? connectAllowed(p, name) : hostAllowed(p, name) || !!net.isIP(normalHost(name)));
  const notes = (fn: string) => fn === 'lookup' || fn === 'resolve4' || fn === 'resolve6';
  const undoDns: (() => void)[] = [];
  const holders: [any, boolean][] = [[dns, false], [dns.Resolver.prototype, false], [dns.promises, true], [dns.promises.Resolver.prototype, true]];
  for (const [holder, promised] of holders)
    for (const fn of DNS_CALLS) {
      const orig = holder[fn];
      if (typeof orig !== 'function') continue;
      undoDns.push(() => (holder[fn] = orig));
      holder[fn] = promised
        ? function (this: any, name: any, ...rest: any[]) {
            if (!mayAsk(fn, name)) return Promise.reject(refuse(name));
            const r = orig.call(this, name, ...rest);
            return notes(fn) ? r.then((x: any) => (noteAddresses(name, x), x)) : r;
          }
        : function (this: any, name: any, ...rest: any[]) {
            const cb = rest[rest.length - 1];
            if (!mayAsk(fn, name)) {
              const err = refuse(name);
              if (typeof cb !== 'function') throw err;
              process.nextTick(cb, err);
              return {};
            }
            if (!notes(fn) || typeof cb !== 'function') return orig.call(this, name, ...rest);
            return orig.call(this, name, ...rest.slice(0, -1), (err: any, addr: any, ...more: any[]) => (err || noteAddresses(name, addr), cb(err, addr, ...more)));
          };
    }
  syncBuiltinESMExports();
  const undo = () => {
    globalThis.fetch = saved.fetch;
    (net as any).connect = saved.netConnect;
    (net as any).createConnection = saved.netCreate;
    (tls as any).connect = saved.tlsConnect;
    http.Agent.prototype.createConnection = saved.agentCreate;
    net.Socket.prototype.connect = saved.sockConnect;
    dgram.Socket.prototype.send = saved.udpSend;
    dgram.Socket.prototype.connect = saved.udpConnect;
    for (const f of undoDns.reverse()) f();
    syncBuiltinESMExports();
    if (g.__sgOutsideUndo === undo) g.__sgOutsideUndo = null;
    g.__sgOutsidePolicy = undefined;
  };
  g.__sgOutsideUndo = undo;
  return undo;
}

/** Whether the guard is installed in this process, and in which mode. */
export const guardMode = (): string => g.__sgOutsidePolicy?.mode || 'off';
