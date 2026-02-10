/**
 * Unit тесты для SyncIndicator
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SyncIndicator } from '../SyncIndicator';

const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('../../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe('SyncIndicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue({
      pending_count: 0,
      failed_count: 0,
      is_online: true,
    });
  });

  it('fetches sync status on mount', async () => {
    render(<SyncIndicator />);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('get_sync_status');
    });
  });

  it('shows synced state when online and no pending/failed', async () => {
    render(<SyncIndicator />);
    await waitFor(() => {
      expect(screen.getByText(/Синхронизировано/i)).toBeInTheDocument();
    });
  });

  it('shows error state when failed_count > 0 (clickable with title)', async () => {
    mockInvoke.mockResolvedValue({
      pending_count: 0,
      failed_count: 2,
      is_online: true,
    });
    render(<SyncIndicator />);
    await waitFor(() => {
      expect(screen.getByTitle(/Кликните, чтобы посмотреть детали 2 ошибок/)).toBeInTheDocument();
    });
  });
});
