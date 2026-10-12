'use client';

import { useSyncExternalStore } from 'react';
import {
  getDataStatus,
  getServerDataStatus,
  subscribeDataStatus,
  type DataStatus,
} from '@/lib/services/data-status';

/** Freshness and access state of whatever has been read so far. */
export function useDataStatus(): DataStatus {
  return useSyncExternalStore(subscribeDataStatus, getDataStatus, getServerDataStatus);
}
