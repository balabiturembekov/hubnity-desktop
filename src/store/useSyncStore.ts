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

export const useSyncStore = create<SyncStore>((set, get) => ({
  status: null,
  isLoading: true,

  fetchSyncStatus: async () => {
    try {
      const result = await invoke<SyncStatus>('get_sync_status');
      const prev = get().status;
      if (prev && prev.is_online !== result.is_online) {
        logger.debugTerminal('NET', `${prev.is_online ? 'online' : 'offline'} -> ${result.is_online ? 'online' : 'offline'}`);
      }
      set({ status: result, isLoading: false });
    } catch (error) {
      logger.error('SYNC_STORE', 'Failed to get sync status', error);
      const prev = get().status;
      const newStatus = prev
        ? { ...prev, is_online: false }
        : { pending_count: 0, failed_count: 0, is_online: false };
      if (prev?.is_online) {
        logger.debugTerminal('NET', 'online -> offline (fetch failed)');
      }
      set({ status: newStatus, isLoading: false });
    }
  },
}));
