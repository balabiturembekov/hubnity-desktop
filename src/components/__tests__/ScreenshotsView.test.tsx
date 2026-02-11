/**
 * Unit тесты для ScreenshotsView
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { ScreenshotsView } from '../ScreenshotsView';

const mockGetScreenshots = vi.fn();

vi.mock('../../store/useTrackerStore', () => ({
  useTrackerStore: {
    getState: () => ({ 
      getScreenshots: mockGetScreenshots,
      currentTimeEntry: {
        id: 'te-1',
        userId: 'user1', // Must match current user id
        projectId: 'p1',
        startTime: '2024-01-01T00:00:00Z',
        endTime: null,
        duration: 0,
        description: '',
        status: 'RUNNING' as const,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
    }),
  },
}));

vi.mock('../../lib/current-user', () => ({
  getCurrentUser: () => ({ id: 'user1', name: 'U', email: 'u@u.com' }),
}));

vi.mock('../../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe('ScreenshotsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetScreenshots.mockResolvedValue([]);
  });

  it('returns null when timeEntryId is null', () => {
    const { container } = render(<ScreenshotsView timeEntryId={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('loads screenshots when timeEntryId is provided', async () => {
    mockGetScreenshots.mockResolvedValue([
      {
        id: 's1',
        timeEntryId: 'te-1',
        imageUrl: 'https://example.com/1.png',
        thumbnailUrl: 'https://example.com/1-thumb.png',
        timestamp: '2024-01-01T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
      },
    ]);
    render(<ScreenshotsView timeEntryId="te-1" />);
    await waitFor(() => {
      expect(mockGetScreenshots).toHaveBeenCalledWith('te-1');
    });
  });
});
