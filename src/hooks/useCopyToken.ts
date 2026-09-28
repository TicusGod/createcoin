import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useCallback, useState } from 'react';
import {
  copyTrendingToken,
  type CopyStage,
  type CopyTrendingSourceHint,
} from '../services/copyTokenService';

export function useCopyToken() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [isCopying, setIsCopying] = useState(false);
  const [stage, setStage] = useState<CopyStage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const copy = useCallback(
    async (sourceMint: string, sourceHint?: CopyTrendingSourceHint) => {
      setIsCopying(true);
      setError(null);
      setStage(null);
      try {
        return await copyTrendingToken({
          connection,
          wallet,
          sourceMint,
          sourceHint,
          onProgress: (s) => setStage(s),
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unknown error');
        setStage(null);
        throw e;
      } finally {
        setIsCopying(false);
      }
    },
    [connection, wallet],
  );

  return { copyToken: copy, isCopying, stage, error };
}
