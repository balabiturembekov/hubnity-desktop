/**
 * Unit тесты для вспомогательных функций SyncIndicator
 */
import { describe, it, expect } from 'vitest';

type SyncState = 'synced' | 'syncing' | 'offline' | 'error';

interface SyncStatus {
  pending_count: number;
  failed_count: number;
  is_online: boolean;
}

// getSyncState - функция из SyncIndicator.tsx
function getSyncState(status: SyncStatus): SyncState {
  if (!status.is_online) {
    return 'offline';
  }
  if (status.failed_count > 0) {
    return 'error';
  }
  if (status.pending_count > 0) {
    return 'syncing';
  }
  return 'synced';
}

describe('getSyncState', () => {
  it('returns offline when not online', () => {
    expect(getSyncState({ pending_count: 0, failed_count: 0, is_online: false })).toBe('offline');
  });

  it('returns error when failed_count > 0', () => {
    expect(getSyncState({ pending_count: 0, failed_count: 1, is_online: true })).toBe('error');
  });

  it('returns syncing when pending_count > 0 and no errors', () => {
    expect(getSyncState({ pending_count: 5, failed_count: 0, is_online: true })).toBe('syncing');
  });

  it('returns synced when online, no pending, no errors', () => {
    expect(getSyncState({ pending_count: 0, failed_count: 0, is_online: true })).toBe('synced');
  });

  it('prioritizes error over syncing', () => {
    expect(getSyncState({ pending_count: 5, failed_count: 1, is_online: true })).toBe('error');
  });
});
