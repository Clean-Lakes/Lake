import { useCallback, useEffect, useState } from 'react';
import type { LakeDataOverview, LakeDataRequest } from '@zcode/shared';
import { usePlatform } from '@/hooks/usePlatform.js';

export function useLakeData() {
  const platform = usePlatform();
  const [overview, setOverview] = useState<LakeDataOverview>({ lakes: [], resources: [], bindings: [], workflowLinks: [] });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useCallback(async (input: LakeDataRequest) => {
    if (!platform.lakeDataRequest) throw new Error('此客户端未提供 LAKE 数据层');
    return platform.lakeDataRequest(input);
  }, [platform]);
  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try { setOverview(await request({ action: 'overview' }) as LakeDataOverview); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'LAKE 数据读取失败'); }
    finally { setLoading(false); }
  }, [request]);
  const mutate = useCallback(async (input: LakeDataRequest) => {
    setLoading(true); setError('');
    try { const result = await request(input); await refresh(); return result; }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'LAKE 数据保存失败'); return undefined; }
    finally { setLoading(false); }
  }, [refresh, request]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { overview, loading, error, refresh, mutate, request };
}
