import { useEffect, useState } from 'react';
import { useServices } from '@/hooks/useServices.js';

/** Catalog and execution stay in the native service; LAKE stores only links. */
export function useLakeGlobalWorkflows(enabled: boolean) {
  const { zcodeAgentService } = useServices();
  const [names, setNames] = useState<string[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setError('');
    void zcodeAgentService.listSavedWorkflows({ scope: 'global' }).then(result => {
      if (active) setNames(result.workflows.map(entry => entry.name));
    }).catch(() => { if (active) setError('全局工作流读取失败，请稍后刷新'); });
    return () => { active = false; };
  }, [enabled, zcodeAgentService]);
  return { names, error };
}
