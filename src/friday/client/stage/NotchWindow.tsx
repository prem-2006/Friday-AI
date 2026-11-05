// Friday: the desktop notch window on its own. main.tsx loads only this (not
// the whole app) for #/notch, so the pill shows a second or two after a start.
// It passes FridayStage what App would: the workspace and whether Friday is
// set up or paused, refreshed every 3 s.
import { useCallback, useEffect, useState } from 'react';
import type { State, WorkspaceState } from '../../../shared/types';
import { api, ApiError } from '../../../client/api';
import { FridayStage } from './FridayStage';

export function NotchWindow() {
  const [state, setState] = useState<State>();
  const [workspace, setWorkspace] = useState<WorkspaceState>();
  const refresh = useCallback(async () => {
    try {
      const [s, w] = await Promise.all([
        api<State>('/state'),
        api<WorkspaceState>('/workspace'),
      ]);
      setState(s);
      setWorkspace(w);
    } catch (e) {
      // Like App: a refused token shows the offline pill; a server that is
      // still starting keeps what was last loaded.
      if (e instanceof ApiError && e.status === 401) setWorkspace(undefined);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);
  if (!state || !workspace?.dots.length)
    return <FridayStage variant="notch" configured={false} onExit={() => {}} />;
  return (
    <FridayStage
      variant="notch"
      workspace={workspace}
      configured={workspace.setup.missing.length === 0}
      paused={!!state.settings.paused}
      onResume={() =>
        void api('/settings', 'PATCH', { paused: false }).then(refresh)
      }
      onExit={() => {}}
    />
  );
}
