import { useState, useCallback } from 'react';
import type { Viewer, UsePresenceViewers, UsePresenceViewersReturn } from '../../types/usePresenceViewers';

/**
 * Hook for managing presence viewers with automatic fade-out handling.
 * Supports both tuple and object destructuring patterns.
 */
export const usePresenceViewers: UsePresenceViewers = (
  initialViewers: Viewer[] = []
) => {
  const [viewers, setViewers] = useState<Viewer[]>(initialViewers);

  const markActive = useCallback((newViewers: Viewer[]) => {
    setViewers(
      newViewers.map(v => ({
        ...v,
        fadingOut: false,
      }))
    );
  }, []);

  const viewerCount = viewers.filter(v => !v.fadingOut).length;

  // Support both tuple [viewers, markActive, viewerCount] and object destructuring
  const result: UsePresenceViewersReturn = [
    viewers,
    markActive,
    viewerCount,
  ] as UsePresenceViewersReturn;

  result.viewers = viewers;
  result.markActive = markActive;
  result.viewerCount = viewerCount;

  return result;
};
