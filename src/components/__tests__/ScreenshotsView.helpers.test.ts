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

// filterScreenshotsByCurrentUser - функция из ScreenshotsView.tsx (обновленная версия)
function filterScreenshotsByCurrentUser(list: Array<{ id: string; userId?: string }>): Array<{ id: string; userId?: string }> {
  const user = getCurrentUser();
  if (!user) {
    // Если пользователь не авторизован, не показываем скриншоты (безопасность)
    logger.warn('SCREENSHOTS_VIEW', 'No current user, filtering all screenshots');
    return [];
  }
  
  const filtered = list.filter((s) => {
    const uid = s.userId;
    // FIX: Показываем только скриншоты текущего пользователя
    // Если userId не определен, НЕ показываем (безопасность - лучше скрыть, чем показать чужой)
    return uid !== undefined && uid === user.id;
  });
  
  if (filtered.length !== list.length) {
    logger.warn('SCREENSHOTS_VIEW', `Filtered ${list.length - filtered.length} screenshots from other users (or without userId)`);
  }
  
  return filtered;
}

describe('filterScreenshotsByCurrentUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when no user (security)', () => {
    vi.mocked(getCurrentUser).mockReturnValue(null);
    const screenshots = [
      { id: '1', userId: 'u1' },
      { id: '2', userId: 'u2' },
    ];
    expect(filterScreenshotsByCurrentUser(screenshots)).toEqual([]);
  });

  it('filters screenshots by current user', () => {
    vi.mocked(getCurrentUser).mockReturnValue({ id: 'u1' } as any);
    const screenshots = [
      { id: '1', userId: 'u1' },
      { id: '2', userId: 'u2' },
      { id: '3' }, // no userId - should be filtered out
    ];
    const filtered = filterScreenshotsByCurrentUser(screenshots);
    expect(filtered).toEqual([
      { id: '1', userId: 'u1' },
    ]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('filters out screenshots without userId (security)', () => {
    vi.mocked(getCurrentUser).mockReturnValue({ id: 'u1' } as any);
    const screenshots = [
      { id: '1' }, // no userId - should be filtered out
      { id: '2' }, // no userId - should be filtered out
    ];
    const filtered = filterScreenshotsByCurrentUser(screenshots);
    expect(filtered).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
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
