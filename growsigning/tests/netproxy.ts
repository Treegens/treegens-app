// For the tests and scripts that reach the real SSL.com sandbox and time-stamp services only: Node's own fetch does
// not go through an HTTPS_PROXY, and the time-stamp services answer on plain http. When HTTPS_PROXY is set, this
// replaces fetch with one that opens a CONNECT tunnel through that proxy for every outside host (http and https), so
// the app's own code runs unchanged on a machine that can only reach the internet through such a proxy. Without
// HTTPS_PROXY it does nothing. Never imported by the app.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';

const local = (h: string) => h === 'localhost' || h === '::1' || /^127\./.test(h) || h === '[::1]';

function tunnel(proxy: URL, host: string, port: number, signal?: AbortSignal | null): Promise<net.Socket> {
  return new Promise((ok, no) => {
    const s = net.connect(Number(proxy.port || 80), proxy.hostname);
    const fail = (e: any) => (s.destroy(), no(e));
    signal?.addEventListener('abort', () => fail(signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    s.once('error', fail);
    s.once('connect', () => s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    let head = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      head = Buffer.concat([head, d]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      s.off('data', onData);
      const status = Number(/^HTTP\/1\.\d (\d{3})/.exec(head.toString('latin1'))?.[1] || 0);
      if (status !== 200) return fail(Object.assign(new Error(`the proxy refused ${host}:${port} (HTTP ${status})`), { cause: { code: `PROXY_${status}` } }));
      if (head.length > end + 4) s.unshift(head.subarray(end + 4));
      ok(s);
    };
    s.on('data', onData);
  });
}

/** Installs the proxied fetch when HTTPS_PROXY is set. Returns a function that puts the real fetch back. */
export function useProxyForFetch(): () => void {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!raw) return () => {};
  const proxy = new URL(raw);
  const real = globalThis.fetch;
  const ca = process.env.NODE_EXTRA_CA_CERTS && fs.existsSync(process.env.NODE_EXTRA_CA_CERTS) ? fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS) : undefined;
  const proxied = async (input: any, init: any = {}): Promise<Response> => {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input));
    if (local(url.hostname) || !/^https?:$/.test(url.protocol)) return real(input, init);
    const method = (init.method || req?.method || 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers || req?.headers || {}).forEach((v, k) => (headers[k] = v));
    let body: Buffer | undefined;
    if (init.body != null) body = typeof init.body === 'string' ? Buffer.from(init.body) : Buffer.from(init.body instanceof ArrayBuffer ? new Uint8Array(init.body) : init.body);
    if (body) headers['content-length'] = String(body.length);
    const secure = url.protocol === 'https:';
    const port = Number(url.port || (secure ? 443 : 80));
    const signal: AbortSignal | undefined = init.signal || req?.signal;
    const sock = await tunnel(proxy, url.hostname, port, signal);
    return await new Promise<Response>((ok, no) => {
      const opts = { method, path: url.pathname + url.search, headers: { host: url.host, ...headers }, createConnection: () => (secure ? tls.connect({ socket: sock, servername: url.hostname, ca: ca ? [...tls.rootCertificates, ca.toString()] : undefined }) : sock) } as any;
      const r = (secure ? https : http).request(opts, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (d) => parts.push(d));
        res.on('end', () => {
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : String(v));
          const status = res.statusCode || 0;
          if (init.redirect === 'error' && status >= 300 && status < 400) return no(new TypeError('fetch failed: redirect'));
          ok(new Response(status === 204 || status === 304 ? null : Buffer.concat(parts), { status, headers: h }));
        });
        res.on('error', no);
      });
      signal?.addEventListener('abort', () => (r.destroy(), no(signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' }))), { once: true });
      r.on('error', no);
      if (body) r.write(body);
      r.end();
    });
  };
  globalThis.fetch = proxied as any;
  return () => void (globalThis.fetch = real);
}
