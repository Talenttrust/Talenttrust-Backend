export interface Viewer {
  id: string;
  name: string;
  fadingOut: boolean;
}

export interface UsePresenceViewersReturn extends Array<Viewer[] | ((viewers: Viewer[]) => void) | number> {
  0: Viewer[];
  1: (viewers: Viewer[]) => void;
  2: number;
  viewers: Viewer[];
  markActive: (viewers: Viewer[]) => void;
  viewerCount: number;
}

export type UsePresenceViewers = (initialViewers?: Viewer[]) => UsePresenceViewersReturn;
