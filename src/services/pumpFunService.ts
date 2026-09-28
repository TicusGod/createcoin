import axios from 'axios';
import { ipfsToHttp } from './ipfsService';
import { getApiProxyHeaders } from './apiProxy';

const PUMP_API = '/api/pump';

export type PumpFunCoin = {
  mint: string;
  name: string;
  symbol: string;
  description: string;
  imageUri: string;
  metadataUri: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  marketCap: number;
  priceUsd: number;
  volume24h: number;
  holders: number;
  bondingCurveProgress: number;
  createdAt: number;
  /** Unix ms when available from API (pump.fun last trade / last_reply). */
  lastTradeAt: number;
  creator: string;
};

const cache = new Map<string, { at: number; data: PumpFunCoin[] }>();
const CACHE_MS = 30_000;

function num(v: unknown, d = 0): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function normalizeCoin(raw: Record<string, unknown>): PumpFunCoin | null {
  const mint = str(raw.mint ?? raw.coinMint ?? raw.id);
  if (!mint || mint.length < 32) return null;
  const imageRaw = str(raw.image_uri ?? raw.imageUrl ?? raw.imageUri ?? raw.image ?? raw.uri);
  const imageUri = imageRaw.startsWith('ipfs://') ? ipfsToHttp(imageRaw) : imageRaw;
  return {
    mint,
    name: str(raw.name) || 'Unknown',
    symbol: str(raw.symbol ?? raw.ticker) || '???',
    description: str(raw.description ?? raw.desc),
    imageUri,
    metadataUri: str(raw.metadata_uri ?? raw.metadataUri ?? raw.uri),
    twitter: str(raw.twitter) || undefined,
    telegram: str(raw.telegram) || undefined,
    website: str(raw.website) || undefined,
    marketCap: num(raw.market_cap ?? raw.marketCap),
    priceUsd: num(raw.usd_market_cap ?? raw.price_usd ?? raw.priceUsd),
    volume24h: num(raw.volume_24h ?? raw.volume24h),
    holders: num(raw.num_holders ?? raw.numHolders ?? raw.holders),
    bondingCurveProgress: num(raw.bonding_curve_progress ?? raw.bondingCurveProgress),
    createdAt: num(raw.created_timestamp ?? raw.creationTime ?? raw.createdAt ?? raw.created_at),
    lastTradeAt: num(
      raw.last_trade_timestamp ??
        raw.last_reply_timestamp ??
        raw.last_trade_at ??
        raw.lastReplyAt,
    ),
    creator: str(raw.creator ?? raw.creator_address ?? raw.dev),
  };
}

function normalizeList(payload: unknown): PumpFunCoin[] {
  if (!payload || typeof payload !== 'object') return [];
  const root = payload as Record<string, unknown>;
  const arr =
    (Array.isArray(root) ? root : null) ??
    (Array.isArray(root.data) ? (root.data as unknown[]) : null) ??
    (Array.isArray(root.coins) ? (root.coins as unknown[]) : null) ??
    (Array.isArray(root.results) ? (root.results as unknown[]) : null);
  if (!arr) return [];
  const out: PumpFunCoin[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const c = normalizeCoin(item as Record<string, unknown>);
    if (c) out.push(c);
  }
  return out;
}

function isTransientAxiosError(e: unknown): boolean {
  if (!axios.isAxiosError(e)) return true;
  const status = e.response?.status;
  if (typeof status !== 'number') return true; // network / timeout
  return status === 429 || status >= 500;
}

async function axiosRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isTransientAxiosError(e)) throw e; // 4xx (incl. 404) — no retry
      await new Promise((r) => setTimeout(r, 400 * 2 ** i));
    }
  }
  throw last;
}

async function pumpGet(url: string, headers: Record<string, string>): Promise<unknown> {
  if (import.meta.env.DEV) {
    console.warn(`[PUMP] request URL: ${url}`);
  }
  try {
    const res = await axios.get<unknown>(url, {
      headers: getApiProxyHeaders(headers),
      timeout: 10_000,
    });
    if (import.meta.env.DEV) {
      console.warn(`[PUMP] response status: ${res.status}`);
    }
    if (res.status >= 400) {
      throw new Error(`Pump HTTP ${res.status}`);
    }
    return res.data;
  } catch (e) {
    if (import.meta.env.DEV && axios.isAxiosError(e) && typeof e.response?.status === 'number') {
      console.warn(`[PUMP] response status: ${e.response.status}`);
    }
    throw e;
  }
}

/** frontend-api-v3 /coins/search expects these sort names (mintlify docs). */
function sortForV3Search(
  sort: 'last_trade_timestamp' | 'market_cap' | 'created_timestamp',
): string {
  if (sort === 'last_trade_timestamp') return 'last_reply';
  return sort;
}

/**
 * Trending: `last_trade_timestamp` uses v3 `/coins/search` first (sort `last_reply`, aligns with pump.fun tab).
 * Other sorts try advanced `/coins/list` first, then search if empty (JWT via env usually required for search).
 * @see https://mintlify.wiki/BankkRoll/pumpfun-apis/api-reference/coins/search
 */
export async function getTrendingCoins(params?: {
  limit?: number;
  offset?: number;
  timeframe?: '1h' | '6h' | '24h';
  sort?: 'last_trade_timestamp' | 'market_cap' | 'created_timestamp';
  order?: 'ASC' | 'DESC';
  /** When true, skip short-lived cache so manual refresh fetches fresh data. */
  force?: boolean;
}): Promise<PumpFunCoin[]> {
  const limit = params?.limit ?? 24;
  const offset = params?.offset ?? 0;
  const sort = params?.sort ?? 'market_cap';
  const order = params?.order ?? 'DESC';
  const force = params?.force ?? false;
  const key = `${sort}-${order}-${limit}-${offset}`;
  if (!force) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  }

  const headers: Record<string, string> = { Accept: 'application/json' };

  const sortV3 = sortForV3Search(sort);
  const searchParams = new URLSearchParams({
    searchTerm: '',
    limit: String(limit),
    offset: String(offset),
    sort: sortV3,
    order,
    includeNsfw: 'false',
    creator: '',
    complete: '',
    meta: '',
    type: '',
  });

  let list: PumpFunCoin[] = [];
  let listFailed = false;
  let searchFailed = false;

  const fetchSearch = () =>
    axiosRetry(() => pumpGet(`${PUMP_API}/coins/search?${searchParams.toString()}`, headers));

  const fetchList = () => axiosRetry(() => pumpGet(`${PUMP_API}/coins/list`, headers));

  /** Matches pump.fun ?tab=last_trade_timestamp — v3 search supports sort last_reply; list does not. */
  if (sort === 'last_trade_timestamp') {
    try {
      const data = await fetchSearch();
      list = normalizeList(data);
    } catch {
      searchFailed = true;
      list = [];
    }
    if (!list.length) {
      try {
        const data = await fetchList();
        list = normalizeList(data);
        list = list.slice(offset, offset + limit);
      } catch {
        listFailed = true;
        list = [];
      }
    }
  } else {
    try {
      const data = await fetchList();
      list = normalizeList(data);
      list = list.slice(offset, offset + limit);
    } catch {
      listFailed = true;
      list = [];
    }

    if (!list.length) {
      try {
        const data = await fetchSearch();
        list = normalizeList(data);
      } catch {
        searchFailed = true;
        list = [];
      }
    }
  }

  if (listFailed && searchFailed) {
    console.warn('[PUMP] all trending endpoints failed');
  }

  cache.set(key, { at: Date.now(), data: list });
  return list;
}

/**
 * Coin detail: frontend-api-v3 `/coins/{mint}`, then advanced-api-v2 `/coins/metadata/{mint}`.
 */
export async function getCoinDetails(mint: string): Promise<PumpFunCoin | null> {
  const headers: Record<string, string> = { Accept: 'application/json' };

  const enc = encodeURIComponent(mint);
  const urls = [
    `${PUMP_API}/coins/${enc}?sync=true`,
    `${PUMP_API}/coins/${enc}`,
    `${PUMP_API}/coins/metadata/${enc}`,
  ];

  let failureCount = 0;
  for (const url of urls) {
    try {
      const data = await axiosRetry(() => pumpGet(url, headers));
      if (data && typeof data === 'object') {
        const obj = data as Record<string, unknown>;
        const inner = (obj.data ?? obj.coin ?? obj.metadata ?? obj) as Record<string, unknown>;
        const c = normalizeCoin(inner);
        if (c) return c;
      }
    } catch {
      failureCount += 1;
    }
  }
  if (failureCount === urls.length) {
    console.warn('[PUMP] all coin detail endpoints failed');
  }
  return null;
}
