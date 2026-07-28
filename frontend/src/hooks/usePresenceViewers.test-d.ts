import { expectType } from 'tsd';
import { usePresenceViewers } from './usePresenceViewers';
import type { Viewer, UsePresenceViewersReturn } from '../../types/usePresenceViewers';

const mockViewers: Viewer[] = [
  { id: '1', name: 'Alice', fadingOut: false },
];

// Test return type
const result = usePresenceViewers(mockViewers);
expectType<UsePresenceViewersReturn>(result);

// Test tuple destructuring
const [viewers, markActive, viewerCount] = usePresenceViewers(mockViewers);
expectType<Viewer[]>(viewers);
expectType<(viewers: Viewer[]) => void>(markActive);
expectType<number>(viewerCount);

// Test object destructuring
const { viewers: v, markActive: m, viewerCount: vc } = usePresenceViewers(
  mockViewers
);
expectType<Viewer[]>(v);
expectType<(viewers: Viewer[]) => void>(m);
expectType<number>(vc);

// Test array index access
const viewers0 = result[0];
const markActive1 = result[1];
const viewerCount2 = result[2];
expectType<Viewer[]>(viewers0);
expectType<(viewers: Viewer[]) => void>(markActive1);
expectType<number>(viewerCount2);

// Test property access
const propViewers = result.viewers;
const propMarkActive = result.markActive;
const propViewerCount = result.viewerCount;
expectType<Viewer[]>(propViewers);
expectType<(viewers: Viewer[]) => void>(propMarkActive);
expectType<number>(propViewerCount);
