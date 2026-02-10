/**
 * Unit тесты для вспомогательных функций ScreenshotsView
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getCurrentUser } from '../../lib/current-user';
import { logger } from '../../lib/logger';

vi.mock('../../lib/current-user', () => ({
  getCurrentUser: vi.fn(),
}));

vi.mock('../../lib/logger', () => ({
  logger: { warn: vi.fn() },
}));

// filterScreenshotsByCurrentUser - функция из ScreenshotsView.tsx
function filterScreenshotsByCurrentUser(list: Array<{ id: string; userId?: string }>): Array<{ id: string; userId?: string }> {
  const user = getCurrentUser();
  if (!user) return list;
  const filtered = list.filter((s) => {
    const uid = s.userId;
    return uid === undefined || uid === user.id;
  });
  if (filtered.length !== list.length) {
    logger.warn('SCREENSHOTS_VIEW', `Filtered ${list.length - filtered.length} screenshots from other users`);
  }
  return filtered;
}

describe('filterScreenshotsByCurrentUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns all screenshots when no user', () => {
    vi.mocked(getCurrentUser).mockReturnValue(null);
    const screenshots = [
      { id: '1', userId: 'u1' },
      { id: '2', userId: 'u2' },
    ];
    expect(filterScreenshotsByCurrentUser(screenshots)).toEqual(screenshots);
  });

  it('filters screenshots by current user', () => {
    vi.mocked(getCurrentUser).mockReturnValue({ id: 'u1' } as any);
    const screenshots = [
      { id: '1', userId: 'u1' },
      { id: '2', userId: 'u2' },
      { id: '3' }, // no userId
    ];
    const filtered = filterScreenshotsByCurrentUser(screenshots);
    expect(filtered).toEqual([
      { id: '1', userId: 'u1' },
      { id: '3' },
    ]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('keeps screenshots without userId', () => {
    vi.mocked(getCurrentUser).mockReturnValue({ id: 'u1' } as any);
    const screenshots = [
      { id: '1' },
      { id: '2' },
    ];
    expect(filterScreenshotsByCurrentUser(screenshots)).toEqual(screenshots);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps all screenshots when all match current user', () => {
    vi.mocked(getCurrentUser).mockReturnValue({ id: 'u1' } as any);
    const screenshots = [
      { id: '1', userId: 'u1' },
      { id: '2', userId: 'u1' },
    ];
    expect(filterScreenshotsByCurrentUser(screenshots)).toEqual(screenshots);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
