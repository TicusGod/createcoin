// Vercel Edge Middleware.
//
// Gates the coincreate.fun → coincreate.co 307 behind a private recording
// cookie. Owner activates the cookie once with ?recording_key=<secret>;
// after that their browser gets served the app directly on coincreate.fun
// (keeping the pretty URL in the address bar for screen recordings). Every
// other visitor keeps getting the ordinary redirect exactly as before.
//
// Infrastructure requirement: the domain "coincreate.fun" MUST be attached
// to this Vercel project as a normal domain (Vercel dashboard → createcoin →
// Settings → Domains → Add). If it is configured as a domain-level Redirect
// alias, the redirect fires BEFORE middleware and this file has no effect.

export const config = {
  // Skip the middleware for static build assets and images — a recording
  // user is authenticated by the cookie on the initial "/" request and can
  // then load /assets/*.js unimpeded, while a non-recording user never
  // reaches those paths (the "/" request 307's them away first).
  matcher: '/((?!assets/|favicon|logo\\.svg|dexscreener\\.png|robots\\.txt|sitemap\\.xml).*)',
};

const RECORDING_HOST = 'coincreate.fun';
const DEFAULT_TARGET = 'https://coincreate.co';
const COOKIE_NAME = 'cc_recording';
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 30;
// HMAC message pinned so rotating the secret invalidates every issued cookie,
// and so a value from an unrelated HMAC use of the same secret cannot be
// replayed here.
const HMAC_MESSAGE = 'coincreate-recording:v1';

function base64url(bytes: Uint8Array): string {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function deriveCookieValue(secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(HMAC_MESSAGE));
  return base64url(new Uint8Array(sig));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(/;\s*/)) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return out;
}

function buildRedirectTarget(url: URL): string {
  const raw = (process.env.RECORDING_REDIRECT_TARGET || DEFAULT_TARGET).trim();
  const base = raw.replace(/\/+$/, '');
  return `${base}${url.pathname}${url.search}`;
}

export default async function middleware(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);

  // Only touch requests that arrived on the recording host. coincreate.co,
  // vercel preview subdomains and everything else are served untouched.
  if (url.hostname !== RECORDING_HOST) return;

  const secret = process.env.RECORDING_BYPASS_SECRET;
  const cookies = parseCookies(request.headers.get('cookie'));

  // --- Logout: clear the cookie, then honor the ordinary redirect. -------
  if (url.searchParams.has('recording_logout')) {
    url.searchParams.delete('recording_logout');
    return new Response(null, {
      status: 307,
      headers: {
        Location: buildRedirectTarget(url),
        'Set-Cookie': `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }

  // --- Activation via ?recording_key=... ---------------------------------
  const suppliedKey = url.searchParams.get('recording_key');
  if (suppliedKey !== null) {
    const looksValid = !!secret && timingSafeEqual(suppliedKey, secret);
    if (looksValid) {
      const cookieValue = await deriveCookieValue(secret!);
      url.searchParams.delete('recording_key');
      const cleanUrl = `${url.origin}${url.pathname}${url.search}`;
      return new Response(null, {
        status: 307,
        headers: {
          Location: cleanUrl,
          'Set-Cookie':
            `${COOKIE_NAME}=${cookieValue}; Path=/; Max-Age=${COOKIE_MAX_AGE_S};` +
            ' HttpOnly; Secure; SameSite=Lax',
        },
      });
    }
    // Wrong key → fall through to the ordinary redirect. The response is
    // indistinguishable from a normal visit so nothing signals to a probing
    // client whether they guessed the parameter name right.
  }

  // --- Existing recording cookie? Serve the app on coincreate.fun. -------
  const cookieValue = cookies.get(COOKIE_NAME);
  if (cookieValue && secret) {
    const expected = await deriveCookieValue(secret);
    if (timingSafeEqual(cookieValue, expected)) {
      return;
    }
  }

  // --- Default: the existing 307 --------------------------------------
  return new Response(null, {
    status: 307,
    headers: { Location: buildRedirectTarget(url) },
  });
}
