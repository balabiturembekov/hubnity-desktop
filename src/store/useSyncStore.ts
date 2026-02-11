import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { logger } from '../lib/logger';

export interface SyncStatus {
  pending_count: number;
  failed_count: number;
  is_online: boolean;
  last_sync_at?: number | null;
}

interface SyncStore {
  status: SyncStatus | null;
  isLoading: boolean;
  fetchSyncStatus: () => Promise<void>;
}

export const useSyncStore = create<SyncStore>((set) => ({
  status: null,
  isLoading: true,

  fetchSyncStatus: async () => {
    try {
      const result = await invoke<SyncStatus>('get_sync_status');
      set({ status: result, isLoading: false });
    } catch (error) {
      logger.error('SYNC_STORE', 'Failed to get sync status', error);
      set({
        status: {
          pending_count: 0,
          failed_count: 0,
          is_online: false,
        },
        isLoading: false,
      });
    }
  },
}));
