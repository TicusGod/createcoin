import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { RefreshCw, Zap } from 'lucide-react';
import LaunchSuccessModal from './LaunchSuccessModal';
import { useSolanaWallet } from '../hooks/useSolanaWallet';
import { useTrendingCoins } from '../hooks/useTrendingCoins';
import { useCopyToken } from '../hooks/useCopyToken';
import { prefetchCopyMetadata, prewarmCopyTrendingRpc } from '../services/copyTokenService';
import { useAppStore } from '../stores/useAppStore';
import { env } from '../config/env';
import { withTransactionToast } from '../utils/transactionToast';

interface TrendingToken {
  id: string;
  name: string;
  symbol: string;
  imageUrl: string;
  marketCap: number;
  activityLabel: string;
  activityText: string;
  dexUrl: string | null;
  xUrl: string | null;
  telegramUrl: string | null;
  rawImageUri: string;
  description: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

/** Coins using this CDN are hidden; copy flow cannot resolve images for them. */
function usesImageDeliveryHost(imageUri: string | undefined): boolean {
  if (!imageUri) return false;
  return imageUri.toLowerCase().includes('imagedelivery.net');
}

function formatMarketCap(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString()}`;
}

function formatCreatedAgo(ts: number): string {
  if (!ts) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function normalizeSocialUrl(raw: string | undefined, kind: 'twitter' | 'telegram'): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  if (t.startsWith('http://') || t.startsWith('https://')) return t;
  if (kind === 'twitter') {
    const h = t.replace(/^@/, '');
    return `https://x.com/${h}`;
  }
  const h = t.replace(/^@/, '');
  return `https://t.me/${h}`;
}

function SocialLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="transition-opacity duration-150 hover:opacity-60"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  );
}

function DexScreenerBadge() {
  return (
    <img
      src="/dexscreener.png"
      alt="Dexscreener"
      className="h-4 w-4 object-contain"
    />
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 fill-[#696e77]" xmlns="http://www.w3.org/2000/svg">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.747l7.73-8.835L1.254 2.25H8.08l4.253 5.622 5.91-5.622Zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function TelegramIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 fill-[#696e77]" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.28 13.47l-2.96-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.194 1.006.131.868.089z" />
    </svg>
  );
}

function TokenCard({
  token,
  onCopy,
  onPrefetch,
  copying,
}: {
  token: TrendingToken;
  onCopy: (token: TrendingToken) => void;
  onPrefetch: (token: TrendingToken) => void;
  copying: string | null;
}) {
  const isCopying = copying === token.id;
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof window === 'undefined' || !('IntersectionObserver' in window)) return;
    let scheduled: number | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            // Delay so a fast scroll past the card does not fire a Pinata upload.
            if (scheduled === null) {
              scheduled = window.setTimeout(() => {
                onPrefetch(token);
              }, 700);
            }
          } else if (scheduled !== null) {
            window.clearTimeout(scheduled);
            scheduled = null;
          }
        }
      },
      { rootMargin: '80px', threshold: 0.4 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (scheduled !== null) window.clearTimeout(scheduled);
    };
  }, [onPrefetch, token]);

  return (
    <div
      ref={containerRef}
      className="bg-[#18191b] rounded-[16px] p-5 flex flex-col gap-4 border border-[#212225] hover:border-[#272a2d] transition-all duration-150"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <img
            src={token.imageUrl}
            alt={token.name}
            className="w-12 h-12 rounded-full object-cover shrink-0 border border-[#212225]"
          />
          <div>
            <p className="text-[#fafafa] font-semibold text-sm leading-tight">{token.name}</p>
            <div className="flex items-center gap-1.5 mt-1 text-[#696e77] text-xs">
              <span className="text-[#b0b4ba]">{token.symbol}</span>
            </div>
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-[#696e77] text-xs mb-1">Market Cap</p>
          <p className="text-[#86efac] font-semibold text-sm">{formatMarketCap(token.marketCap)}</p>
        </div>
      </div>

      <div className="flex items-center gap-1.5 text-[#fb923c] text-xs">
        <span className="w-3 h-3 rounded-full border border-[#fb923c] flex items-center justify-center text-[7px] font-bold leading-none">
          !
        </span>
        <span>{token.activityLabel}: {token.activityText}</span>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          {token.dexUrl && (
            <SocialLink href={token.dexUrl}>
              <DexScreenerBadge />
            </SocialLink>
          )}
          {token.xUrl && (
            <SocialLink href={token.xUrl}>
              <XIcon />
            </SocialLink>
          )}
          {token.telegramUrl && (
            <SocialLink href={token.telegramUrl}>
              <TelegramIcon />
            </SocialLink>
          )}
        </div>
        <button
          onClick={() => onCopy(token)}
          onMouseEnter={() => onPrefetch(token)}
          onFocus={() => onPrefetch(token)}
          disabled={isCopying}
          className="inline-flex items-center gap-1.5 h-9 px-4 rounded-[10px] bg-[#86efac] text-[#052e16] text-xs font-semibold transition-all duration-150 hover:bg-[#bbf7d0] active:translate-y-px disabled:opacity-50 disabled:cursor-not-allowed select-none"
        >
          {isCopying ? (
            <>
              <RefreshCw size={12} className="animate-spin" />
              Copying…
            </>
          ) : (
            <>
              <Zap size={12} fill="#052e16" />
              Copy Coin
            </>
          )}
        </button>
      </div>
    </div>
  );
}

const PLACEHOLDER_IMG =
  'https://images.pexels.com/photos/8370752/pexels-photo-8370752.jpeg?auto=compress&cs=tinysrgb&w=80&h=80&fit=crop';

export default function CopyTrending({ onGoToLiquidity }: { onGoToLiquidity: (mint: string) => void }) {
  const [tab, setTab] = useState<'trending' | 'new'>('trending');
  const [page, setPage] = useState(0);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [pillStyle, setPillStyle] = useState<{ left: number; width: number }>({ left: 0, width: 0 });
  const [copying, setCopying] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [launchResult, setLaunchResult] = useState<{ mintAddress: string; isVirtual: boolean } | null>(null);
  const metadataPrefetchRef = useRef<Map<string, Promise<string>>>(new Map());

  const { publicKey, connected } = useWallet();
  const { connection } = useConnection();
  const { connect } = useSolanaWallet();
  const { coins, loading } = useTrendingCoins(tab, page);
  const { copyToken } = useCopyToken();
  const addUserToken = useAppStore((s) => s.addUserToken);
  const recordTransaction = useAppStore((s) => s.recordTransaction);

  const updatePillPosition = useCallback(() => {
    const el = tabRefs.current[tab];
    if (el) setPillStyle({ left: el.offsetLeft, width: el.offsetWidth });
  }, [tab]);

  useLayoutEffect(() => {
    updatePillPosition();
  }, [updatePillPosition]);

  useLayoutEffect(() => {
    window.addEventListener('resize', updatePillPosition);
    return () => window.removeEventListener('resize', updatePillPosition);
  }, [updatePillPosition]);

  useLayoutEffect(() => {
    setPage(0);
  }, [tab]);

  useEffect(() => {
    if (!loading) setRefreshing(false);
  }, [loading]);

  // Warm the RPC caches (rent exemption, blockhash, priority fee, balance) the
  // moment the page opens or the wallet reconnects, so the Copy Coin click has
  // zero RPC latency in the hot path.
  useEffect(() => {
    prewarmCopyTrendingRpc(connection, publicKey ?? undefined);
    const id = window.setInterval(() => {
      prewarmCopyTrendingRpc(connection, publicKey ?? undefined);
    }, 4_000);
    return () => window.clearInterval(id);
  }, [connection, publicKey]);

  const tokens: TrendingToken[] = useMemo(
    () =>
      coins
        .filter((c) => !usesImageDeliveryHost(c.imageUri))
        .map((c) => ({
          id: c.mint,
          name: c.name,
          symbol: c.symbol.startsWith('$') ? c.symbol : `$${c.symbol}`,
          imageUrl: c.imageUri || PLACEHOLDER_IMG,
          marketCap: c.marketCap,
          activityLabel: 'Pair age',
          activityText: formatCreatedAgo(c.createdAt || c.updatedAt),
          dexUrl: c.dexUrl,
          xUrl: normalizeSocialUrl(c.twitter, 'twitter'),
          telegramUrl: normalizeSocialUrl(c.telegram, 'telegram'),
          rawImageUri: c.imageUri,
          description: c.description,
          twitter: c.twitter,
          telegram: c.telegram,
          website: c.website,
        })),
    [coins],
  );

  const handleRefresh = async () => {
    setRefreshing(true);
    setPage((prev) => prev + 1);
  };

  const buildHint = (token: TrendingToken) => ({
    name: token.name,
    symbol: token.symbol.replace(/^\$/, ''),
    description: token.description,
    imageUri: token.rawImageUri || (token.imageUrl !== PLACEHOLDER_IMG ? token.imageUrl : undefined),
    twitter: token.twitter,
    telegram: token.telegram,
    website: token.website,
  });

  const handlePrefetch = useCallback((token: TrendingToken) => {
    const cache = metadataPrefetchRef.current;
    if (cache.has(token.id)) return;
    const promise = prefetchCopyMetadata(buildHint(token)).catch((e) => {
      // Drop the failed attempt so the copy flow can retry inline.
      cache.delete(token.id);
      throw e;
    });
    cache.set(token.id, promise);
  }, []);

  // Eagerly prefetch metadata for the first few visible cards so a fast click
  // on top-of-page tokens does not wait on Pinata even without a hover.
  useEffect(() => {
    if (!tokens.length) return;
    const timers: number[] = [];
    tokens.slice(0, 4).forEach((token, i) => {
      const id = window.setTimeout(() => handlePrefetch(token), 150 + i * 120);
      timers.push(id);
    });
    return () => {
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, [tokens, handlePrefetch]);

  const handleCopy = async (token: TrendingToken) => {
    if (!connected) {
      connect();
      toast('Connect your wallet to copy');
      return;
    }
    const w = publicKey?.toBase58();
    if (!w || !publicKey) {
      connect();
      return;
    }

    // Precise rent-based balance check is done inline inside copyTrendingToken so we
    // don't need two extra RPC round-trips before the wallet popup here.

    setCopying(token.id);
    try {
      await withTransactionToast('Copying trending token', async () => {
        const hint = buildHint(token);
        const prefetched = metadataPrefetchRef.current.get(token.id);
        let prefetchedUri: string | undefined;
        if (prefetched) {
          try {
            prefetchedUri = await prefetched;
          } catch {
            // Fall back to inline upload below.
          }
        }
        const res = await copyToken(token.id, {
          ...hint,
          metadataUri: prefetchedUri,
        });
        addUserToken(w, {
          mint: res.mint.toBase58(),
          name: token.name,
          symbol: token.symbol.replace(/^\$/, '').toUpperCase(),
          decimals: 6,
          supply: '1000000000',
          walletBalance: '1000000000',
          metadataUri: res.metadataUri,
          imageUri: token.imageUrl,
          createdAt: Date.now(),
          signature: res.signature,
          network: env.network,
          source: 'copied',
          sourceMint: res.sourceMint,
          isVirtual: res.isVirtual,
          authoritiesRevoked: { mint: true, freeze: true, update: true },
        });
        if (!res.isVirtual) {
          recordTransaction(w, {
            signature: res.signature,
            kind: 'copy_trending',
            at: Date.now(),
            network: env.network,
          });
        }
        setLaunchResult({ mintAddress: res.mint.toBase58(), isVirtual: res.isVirtual });
        return {
          signature: res.signature,
          confirmed: res.confirmed,
        };
      }, {
        successMessage: () => 'Token created',
        successAppendSignature: false,
      });
    } catch {
      /* toast handled */
    } finally {
      setCopying(null);
    }
  };

  return (
    <>
      {launchResult && (
        <LaunchSuccessModal
          mintAddress={launchResult.mintAddress}
          isVirtual={launchResult.isVirtual}
          onClose={() => {
            setLaunchResult(null);
          }}
          onGoToLiquidity={onGoToLiquidity}
        />
      )}
      <section className="min-h-screen bg-[#111113] px-4 sm:px-8 pt-12 pb-20">
        <div className="max-w-6xl mx-auto">
          <h1 className="text-3xl font-bold text-[#fafafa] text-center mb-8 tracking-tight">
            Copy Trending Coins in 1 Click
          </h1>

          <div className="flex items-center justify-end mb-6">
            <div className="hidden">
              <div className="relative flex items-center bg-[#212225] rounded-[12px] p-1">
                {(['trending', 'new'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    ref={(el) => {
                      tabRefs.current[t] = el;
                    }}
                    onClick={() => setTab(t)}
                    className={`relative z-10 h-8 px-5 rounded-[10px] text-sm font-semibold capitalize select-none transition-colors duration-200 ${
                      tab === t ? 'text-[#052e16]' : 'text-[#696e77] hover:text-[#fafafa]'
                    }`}
                  >
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
                <div
                  className="absolute top-1 bottom-1 rounded-[10px] bg-[#86efac] transition-all duration-200 ease-in-out pointer-events-none"
                  style={{ left: pillStyle.left, width: pillStyle.width }}
                />
              </div>
            </div>

            <button
              type="button"
              onClick={() => void handleRefresh()}
              className="w-9 h-9 flex items-center justify-center rounded-[10px] bg-[#212225] hover:bg-[#272a2d] transition-all duration-150 active:translate-y-px"
            >
              <RefreshCw size={15} className={`text-[#b0b4ba] ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-48 bg-[#18191b] border border-[#212225] rounded-[16px] animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {tokens.map((token) => (
                <TokenCard
                  key={token.id}
                  token={token}
                  onCopy={handleCopy}
                  onPrefetch={handlePrefetch}
                  copying={copying}
                />
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
