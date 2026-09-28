import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createSignerFromKeypair, percentAmount, publicKey as umiPublicKey, some } from '@metaplex-foundation/umi';
import { walletAdapterIdentity } from '@metaplex-foundation/umi-signer-wallet-adapters';
import { fromWeb3JsKeypair, toWeb3JsInstruction } from '@metaplex-foundation/umi-web3js-adapters';
import { createV1, mplTokenMetadata, TokenStandard } from '@metaplex-foundation/mpl-token-metadata';
import {
  ACCOUNT_SIZE,
  AuthorityType,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { WalletContextState } from '@solana/wallet-adapter-react';
import axios from 'axios';
import BN from 'bn.js';
import { buildTreasuryTransferInstruction, calculateTotalFees, getFeeLamports } from './feeService';
import { buildComputeBudgetInstructions, getDynamicPriorityFee } from './priorityFeeService';
import { confirmTransactionWithBackgroundFallback, sendRawTransactionWithSimulationFallback } from './solanaTxHelpers';
import type { TokenMetadataJson } from './ipfsService';
import { uploadMetadata, normalizeToHttp } from './ipfsService';
import { getCoinDetails } from './pumpFunService';
import { fetchDigitalAsset } from '@metaplex-foundation/mpl-token-metadata';

export type CopyStage =
  | 'fetching_source'
  | 'uploading_image'
  | 'uploading_metadata'
  | 'building_transaction'
  | 'awaiting_signature'
  | 'confirming'
  | 'done';

const DEFAULT_DECIMALS = 6;
const DEFAULT_SUPPLY_UI = 1_000_000_000;
const COPY_TRENDING_METADATA_AND_BUFFER_LAMPORTS = 20_000_000;
const COPY_TRENDING_MAX_DYNAMIC_FEE_LAMPORTS = Math.round(0.5 * LAMPORTS_PER_SOL);
const COPY_TRENDING_FETCH_TIMEOUT_MS = 30_000;
const RPC_PREP_RETRY_DELAYS_MS = [0, 400, 1_000, 2_200];

function isTransientRpcError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('rate limit') ||
    msg.includes('network is congested') ||
    msg.includes('node is behind') ||
    msg.includes('service unavailable') ||
    msg.includes('temporarily unavailable') ||
    msg.includes('gateway timeout') ||
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('fetch failed') ||
    msg.includes('failed to fetch') ||
    msg.includes('socket hang up') ||
    msg.includes('econnreset')
  );
}

async function rpcWithRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RPC_PREP_RETRY_DELAYS_MS.length; attempt++) {
    const delay = RPC_PREP_RETRY_DELAYS_MS[attempt] ?? 0;
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (!isTransientRpcError(e)) throw e;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${label} failed after retries: ${String(lastError)}`);
}

/**
 * Rent-exemption depends only on account size and cluster protocol params —
 * it does not change between clicks. Cached module-level to skip 2 RPC calls
 * per Copy Coin flow after the first one.
 */
const RENT_CACHE_MS = 10 * 60 * 1000;
const rentExemptionCache = new Map<number, { value: number; at: number }>();
async function getRentExemptionCached(connection: Connection, size: number): Promise<number> {
  const hit = rentExemptionCache.get(size);
  if (hit && Date.now() - hit.at < RENT_CACHE_MS) return hit.value;
  const value = await rpcWithRetry(`rentExemption(${size})`, () =>
    connection.getMinimumBalanceForRentExemption(size),
  );
  rentExemptionCache.set(size, { value, at: Date.now() });
  return value;
}

/**
 * Latest blockhash stays valid for ~60 s on-chain. Reusing one for a few
 * seconds is safe and removes another RPC from the hot path.
 */
const BLOCKHASH_CACHE_MS = 8_000;
let blockhashCache: {
  value: { blockhash: string; lastValidBlockHeight: number };
  at: number;
} | null = null;
async function getBlockhashCached(
  connection: Connection,
): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const now = Date.now();
  if (blockhashCache && now - blockhashCache.at < BLOCKHASH_CACHE_MS) {
    return blockhashCache.value;
  }
  const value = await rpcWithRetry('blockhash', () =>
    connection.getLatestBlockhash('confirmed'),
  );
  blockhashCache = { value, at: now };
  return value;
}

/**
 * Balance changes on every trade / send. Cache short — long enough to hide
 * the RPC round-trip on the click, short enough that the pre-flight rent
 * check still catches an actually-empty wallet.
 */
const BALANCE_CACHE_MS = 5_000;
const balanceCache = new Map<string, { value: number; at: number }>();
async function getBalanceCached(connection: Connection, payer: PublicKey): Promise<number> {
  const key = payer.toBase58();
  const hit = balanceCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < BALANCE_CACHE_MS) return hit.value;
  const value = await rpcWithRetry('balance', () => connection.getBalance(payer, 'confirmed'));
  balanceCache.set(key, { value, at: now });
  return value;
}

/**
 * Fire-and-forget prewarm: fills the rent / blockhash / priority-fee / balance
 * caches so the Copy Coin click has zero RPC latency in the common case.
 * Call once when the trending page mounts and again on a short interval.
 */
export function prewarmCopyTrendingRpc(connection: Connection, payer?: PublicKey): void {
  void getRentExemptionCached(connection, MINT_SIZE).catch(() => {});
  void getRentExemptionCached(connection, ACCOUNT_SIZE).catch(() => {});
  void getBlockhashCached(connection).catch(() => {});
  void getDynamicPriorityFee(connection, payer ? [payer] : undefined).catch(() => {});
  if (payer) void getBalanceCached(connection, payer).catch(() => {});
}

function isReusableImageUri(value: string | undefined): value is string {
  return normalizeToHttp(value) !== null;
}

function supplyBn(supplyUi: number, decimals: number): BN {
  const whole = new BN(Math.floor(supplyUi).toString());
  const scale = new BN(10).pow(new BN(decimals));
  return whole.mul(scale);
}

function getCopyTrendingReserveLamports(mintRent: number, ataRent: number): number {
  return mintRent + ataRent + COPY_TRENDING_METADATA_AND_BUFFER_LAMPORTS;
}

function getCopyTrendingDynamicFeeLamports(
  configuredFeeLamports: number,
  balanceLamports: number,
  reserveLamports: number,
): number {
  return Math.max(
    0,
    Math.min(configuredFeeLamports, COPY_TRENDING_MAX_DYNAMIC_FEE_LAMPORTS, balanceLamports - reserveLamports),
  );
}

/**
 * Minimum lamports the payer should hold before copy (platform fee + mint + ATA + metadata headroom).
 */
export async function estimateMinLamportsForCopyTrending(
  connection: Connection,
  payer?: PublicKey | null,
  balanceLamports?: number,
): Promise<number> {
  const { totalLamports: configuredFeeLamports } = calculateTotalFees(['copy_trending'], payer);
  const [mintRent, ataRent] = await Promise.all([
    getRentExemptionCached(connection, MINT_SIZE),
    getRentExemptionCached(connection, ACCOUNT_SIZE),
  ]);
  const reserveLamports = getCopyTrendingReserveLamports(mintRent, ataRent);
  if (balanceLamports === undefined) {
    return reserveLamports + Math.min(configuredFeeLamports, COPY_TRENDING_MAX_DYNAMIC_FEE_LAMPORTS);
  }
  return reserveLamports + getCopyTrendingDynamicFeeLamports(configuredFeeLamports, balanceLamports, reserveLamports);
}

export type CopyTrendingSourceHint = {
  name?: string;
  symbol?: string;
  description?: string;
  imageUri?: string;
  metadataUri?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
};

/**
 * Prefetch metadata JSON to Pinata using card-known fields, so the Copy Coin
 * flow can skip the ~3–10 s Pinata roundtrip when the button is clicked
 * shortly after hover. Returns the eventual metadata URI (ipfs://…).
 */
export function prefetchCopyMetadata(hint: CopyTrendingSourceHint): Promise<string> {
  const name = (hint.name || 'Token').trim() || 'Token';
  const rawSymbol = (hint.symbol || '').replace(/^\$/, '').trim();
  const symbol = (rawSymbol || 'TKN').toUpperCase();
  const description = hint.description || '';
  const imageHttp = hint.imageUri ? hint.imageUri.trim() : '';
  const metaJson: TokenMetadataJson = {
    name,
    symbol,
    description,
    image: imageHttp,
    external_url: hint.website,
    extensions: {
      twitter: hint.twitter,
      telegram: hint.telegram,
      website: hint.website,
    },
  };
  return uploadMetadata(metaJson);
}

export async function copyTrendingToken(params: {
  connection: Connection;
  wallet: WalletContextState;
  sourceMint: string;
  customSupply?: number;
  customDecimals?: number;
  sourceHint?: CopyTrendingSourceHint;
  onProgress?: (stage: CopyStage) => void;
}): Promise<{ mint: PublicKey; signature: string; metadataUri: string; sourceMint: string; isVirtual: boolean; confirmed: boolean }> {
  const w = params.wallet;
  if (!w.publicKey || !w.signTransaction) {
    throw new Error('Wallet not connected');
  }
  const payer = w.publicKey;

  params.onProgress?.('fetching_source');
  let name = 'Token';
  let symbol = 'TKN';
  let description = '';
  let imageHttp = '';
  let sourceMetadataUri: string | undefined;
  let twitter: string | undefined;
  let telegram: string | undefined;
  let website: string | undefined;

  // Short-circuit: if the caller already handed us name + symbol + image (the
  // typical case for cards in the trending list), skip both the pump.fun API
  // roundtrip (3 endpoints × 3 retries — up to ~15 s for a non-pump coin) and
  // the on-chain Metaplex read. Everything else in this section can be
  // populated from the hint below.
  const hintHasCore =
    !!params.sourceHint &&
    !!params.sourceHint.name?.trim() &&
    !!params.sourceHint.symbol?.trim() &&
    !!params.sourceHint.imageUri?.trim();

  const pump = hintHasCore ? null : await getCoinDetails(params.sourceMint);
  if (pump) {
    name = pump.name;
    symbol = pump.symbol.replace(/^\$/, '');
    description = pump.description;
    imageHttp = normalizeToHttp(pump.imageUri) ?? pump.imageUri;
    sourceMetadataUri = normalizeToHttp(pump.metadataUri) ?? undefined;
    twitter = pump.twitter;
    telegram = pump.telegram;
    website = pump.website;
  } else if (!hintHasCore) {
    const umiRead = createUmi(params.connection).use(mplTokenMetadata());
    const asset = await fetchDigitalAsset(umiRead, umiPublicKey(params.sourceMint)).catch(() => null);
    if (asset?.metadata) {
      name = (asset.metadata.name || '').replace(/\0/g, '').trim() || name;
      symbol = asset.metadata.symbol.replace(/\0/g, '').trim() || symbol;
      const uri = (asset.metadata.uri || '').replace(/\0/g, '').trim();
      const httpUri = normalizeToHttp(uri);
      sourceMetadataUri = httpUri ?? undefined;
      description = uri;
      if (httpUri) {
        try {
          const { data } = await axios.get<Record<string, unknown>>(httpUri, { timeout: COPY_TRENDING_FETCH_TIMEOUT_MS });
          const img = typeof data.image === 'string' ? data.image : '';
          const imgHttp = normalizeToHttp(img);
          if (imgHttp) imageHttp = imgHttp;
          if (typeof data.description === 'string') description = data.description;
        } catch {
          description = uri;
        }
      }
    }
  }

  // Fallback: the caller may already know the coin from list/search
  // responses (used by CopyTrending's card data) even if neither
  // /coins/<mint> nor on-chain metadata resolved.
  const hint = params.sourceHint;
  if (hint) {
    const hintName = (hint.name || '').trim();
    if (hintName && (!name || name === 'Token')) name = hintName;
    const hintSymbol = (hint.symbol || '').replace(/^\$/, '').trim();
    if (hintSymbol && (!symbol || symbol === 'TKN')) symbol = hintSymbol;
    const hintImage = normalizeToHttp(hint.imageUri);
    if (hintImage && !isReusableImageUri(imageHttp)) imageHttp = hintImage;
    if (!sourceMetadataUri) {
      const hintMeta = normalizeToHttp(hint.metadataUri);
      if (hintMeta) sourceMetadataUri = hintMeta;
    }
    if (hint.description && !description) description = hint.description;
    if (hint.twitter && !twitter) twitter = hint.twitter;
    if (hint.telegram && !telegram) telegram = hint.telegram;
    if (hint.website && !website) website = hint.website;
  }

  const decimals = params.customDecimals ?? DEFAULT_DECIMALS;
  const supplyUi = params.customSupply ?? DEFAULT_SUPPLY_UI;

  const needsUpload = !sourceMetadataUri;
  if (needsUpload) {
    // Without any source info the copy would be blank — almost certainly a wrong mint.
    const gotSourceInfo =
      (name && name !== 'Token') || (symbol && symbol !== 'TKN') || isReusableImageUri(imageHttp);
    if (!gotSourceInfo) {
      throw new Error('Could not resolve source metadata');
    }
  }

  params.onProgress?.('building_transaction');
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;

  // Kick off every network call in parallel. Pinata upload (up to ~10 s) is
  // the dominant latency before the wallet popup — running RPC prep alongside
  // it cuts the time-to-signature roughly to max(upload, rpc) instead of sum.
  const uploadPromise: Promise<string> = needsUpload
    ? (() => {
        const metadataImageUri = isReusableImageUri(imageHttp)
          ? imageHttp.startsWith('ipfs://') ? imageHttp : imageHttp.trim()
          : '';
        const metaJson: TokenMetadataJson = {
          name,
          symbol: symbol.toUpperCase(),
          description,
          image: metadataImageUri,
          external_url: website,
          extensions: { twitter, telegram, website },
        };
        params.onProgress?.('uploading_metadata');
        return uploadMetadata(metaJson);
      })()
    : Promise.resolve(sourceMetadataUri as string);

  const [lamports, ataRent, priority, currentBalanceLamports, latestBh, resolvedMetaUri] =
    await Promise.all([
      getRentExemptionCached(params.connection, MINT_SIZE),
      getRentExemptionCached(params.connection, ACCOUNT_SIZE),
      getDynamicPriorityFee(params.connection, [payer, mint]),
      getBalanceCached(params.connection, payer),
      getBlockhashCached(params.connection),
      uploadPromise,
    ]);
  const metadataUri = resolvedMetaUri;
  const { blockhash, lastValidBlockHeight } = latestBh;

  const umi = createUmi(params.connection)
    .use(mplTokenMetadata())
    .use(walletAdapterIdentity(w as Parameters<typeof walletAdapterIdentity>[0]));

  const mintSigner = createSignerFromKeypair(umi, fromWeb3JsKeypair(mintKp));

  const metaBuilder = createV1(umi, {
    mint: mintSigner,
    name,
    symbol: symbol.toUpperCase(),
    uri: metadataUri,
    sellerFeeBasisPoints: percentAmount(0),
    decimals: some(decimals),
    tokenStandard: TokenStandard.Fungible,
    isMutable: false,
  });

  const budgetIxs = buildComputeBudgetInstructions(1_200_000, priority);
  const ata = getAssociatedTokenAddressSync(mint, payer, false, TOKEN_PROGRAM_ID);
  const rawSupply = supplyBn(supplyUi, decimals);

  // Fixed platform fee: configured VITE_FEE_COPY_TRENDING_SOL (default 0.5 SOL),
  // capped by COPY_TRENDING_MAX_DYNAMIC_FEE_LAMPORTS. The old "max-extract"
  // behavior — reducing the fee to (balance − reserve) so wallets got drained
  // to the rent floor — is removed: fee no longer depends on the user's balance.
  const reserveLamports = getCopyTrendingReserveLamports(lamports, ataRent);
  if (currentBalanceLamports < reserveLamports) {
    throw new Error('Insufficient SOL for copy trending rent and network costs.');
  }
  const configuredFeeLamports = getFeeLamports('copy_trending', 1, payer);
  const copyFeeLamports = Math.min(configuredFeeLamports, COPY_TRENDING_MAX_DYNAMIC_FEE_LAMPORTS);

  const ixs = [
    ...budgetIxs,
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: mint,
      lamports,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(mint, decimals, payer, payer, TOKEN_PROGRAM_ID),
    ...metaBuilder.getInstructions().map(toWeb3JsInstruction),
    createAssociatedTokenAccountIdempotentInstruction(payer, ata, payer, mint, TOKEN_PROGRAM_ID),
    createMintToInstruction(mint, ata, payer, BigInt(rawSupply.toString()), [], TOKEN_PROGRAM_ID),
    createSetAuthorityInstruction(mint, payer, AuthorityType.MintTokens, null, [], TOKEN_PROGRAM_ID),
    createSetAuthorityInstruction(mint, payer, AuthorityType.FreezeAccount, null, [], TOKEN_PROGRAM_ID),
  ];
  const copyFeeIx = buildTreasuryTransferInstruction(payer, copyFeeLamports);
  if (copyFeeIx) ixs.push(copyFeeIx);

  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();

  const vtx = new VersionedTransaction(msg);
  vtx.sign([mintKp]);

  params.onProgress?.('awaiting_signature');
  const signed = await w.signTransaction(vtx);

  params.onProgress?.('confirming');
  const sig = await sendRawTransactionWithSimulationFallback(params.connection, signed.serialize(), {
    preferSkipPreflight: true,
  });

  const { confirmed } = await confirmTransactionWithBackgroundFallback(
    params.connection,
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  );

  params.onProgress?.('done');
  return { mint, signature: sig, metadataUri, sourceMint: params.sourceMint, isVirtual: false, confirmed };
}
