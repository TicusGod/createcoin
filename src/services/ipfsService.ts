import axios from 'axios';
import { env } from '../config/env';
import { getApiProxyHeaders } from './apiProxy';

export type TokenMetadataJson = {
  name: string;
  symbol: string;
  description: string;
  image: string;
  external_url?: string;
  extensions?: {
    twitter?: string;
    telegram?: string;
    website?: string;
    discord?: string;
    creator_name?: string;
    creator_website?: string;
  };
};

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const PINATA_UPLOAD_TIMEOUT_MS = 60_000;

function loadImageDimensions(file: File): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('invalid image'));
    };
    img.src = url;
  });
}

export async function uploadImage(file: File): Promise<string> {
  if (file.size > MAX_BYTES) {
    throw new Error('Image must be 5MB or smaller');
  }
  if (!ALLOWED.has(file.type)) {
    throw new Error('Image must be PNG, JPEG, GIF, or WebP');
  }
  const { w, h } = await loadImageDimensions(file);
  if (w > 4096 || h > 4096) {
    throw new Error('Image dimensions must be at most 4096×4096');
  }

  const form = new FormData();
  form.append('file', file);

  const { data } = await axios.post<{ IpfsHash: string }>(
    '/api/pinata/file',
    form,
    {
      headers: getApiProxyHeaders({ 'Content-Type': 'multipart/form-data' }),
      timeout: PINATA_UPLOAD_TIMEOUT_MS,
    },
  );
  if (!data?.IpfsHash) {
    throw new Error('Pinata did not return IpfsHash');
  }
  return `ipfs://${data.IpfsHash}`;
}

export async function uploadMetadata(json: TokenMetadataJson): Promise<string> {
  const { data } = await axios.post<{ IpfsHash: string }>(
    '/api/pinata/json',
    { pinataContent: json, pinataMetadata: { name: `${json.symbol}-metadata` } },
    {
      headers: getApiProxyHeaders({ 'Content-Type': 'application/json' }),
      timeout: PINATA_UPLOAD_TIMEOUT_MS,
    },
  );
  if (!data?.IpfsHash) {
    throw new Error('Pinata did not return IpfsHash');
  }
  return `ipfs://${data.IpfsHash}`;
}

export function ipfsToHttp(uri: string): string {
  if (uri.startsWith('ipfs://')) {
    const path = uri.slice('ipfs://'.length);
    return `${env.pinataGateway}/ipfs/${path}`;
  }
  return uri;
}

export function arToHttp(uri: string): string {
  if (uri.startsWith('ar://')) {
    return `https://arweave.net/${uri.slice('ar://'.length)}`;
  }
  return uri;
}

/**
 * Normalize a token-metadata / image URI to an HTTP(S) URL that the browser
 * can fetch. Accepts http(s), ipfs://, ar://, bare IPFS CIDs (v0/v1) and
 * bare Arweave transaction ids. Returns null for anything unrecognised or empty.
 */
export function normalizeToHttp(uri: string | undefined | null): string | null {
  if (!uri) return null;
  const trimmed = uri.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  if (trimmed.startsWith('ipfs://')) return ipfsToHttp(trimmed);
  if (trimmed.startsWith('ar://')) return arToHttp(trimmed);
  if (!trimmed.includes('/')) {
    // Bare Arweave transaction id: 43 chars, base64url alphabet.
    if (/^[A-Za-z0-9_-]{43}$/.test(trimmed)) {
      return `https://arweave.net/${trimmed}`;
    }
    // Bare IPFS CID v0 (Qm...) or v1 (b/z/f...).
    if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(trimmed) || /^[bzf][A-Za-z2-7]{50,}$/.test(trimmed)) {
      return ipfsToHttp(`ipfs://${trimmed}`);
    }
  }
  return null;
}
