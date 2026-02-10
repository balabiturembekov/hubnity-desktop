/**
 * Unit тесты для вспомогательных функций компонентов
 */
import { describe, it, expect } from 'vitest';

// formatTime - функция из Timer.tsx и IdleWindow.tsx
function formatTime(seconds: number): string {
  const displaySeconds = Math.max(0, seconds);
  const hours = Math.floor(displaySeconds / 3600);
  const minutes = Math.floor((displaySeconds % 3600) / 60);
  const secs = displaySeconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// getFullImageUrl - функция из ScreenshotsView.tsx
function getFullImageUrl(imageUrl: string): string {
  if (imageUrl.startsWith('/')) {
    return `https://app.automatonsoft.de${imageUrl}`;
  }
  return imageUrl;
}

// formatDate - функция из FailedTasksDialog.tsx
function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString('ru-RU');
}

// getEntityTypeLabel - функция из FailedTasksDialog.tsx
function getEntityTypeLabel(entityType: string): string {
  const labels: Record<string, string> = {
    time_entry_start: 'Старт трекера',
    time_entry_pause: 'Пауза',
    time_entry_resume: 'Возобновление',
    time_entry_stop: 'Остановка',
    screenshot: 'Скриншот',
    activity: 'Активность',
  };
  return labels[entityType] || entityType;
}

// getPayloadPreview - функция из FailedTasksDialog.tsx
function getPayloadPreview(payload: string): string {
  try {
    const parsed = JSON.parse(payload);
    const safe: any = { ...parsed };
    delete safe.accessToken;
    delete safe.refreshToken;
    delete safe._encrypted;
    delete safe.imageData;
    return JSON.stringify(safe, null, 2);
  } catch {
    return payload.substring(0, 100) + '...';
  }
}

describe('formatTime', () => {
  it('formats zero seconds', () => {
    expect(formatTime(0)).toBe('00:00:00');
  });

  it('formats seconds less than minute', () => {
    expect(formatTime(30)).toBe('00:00:30');
  });

  it('formats minutes and seconds', () => {
    expect(formatTime(125)).toBe('00:02:05');
  });

  it('formats hours, minutes and seconds', () => {
    expect(formatTime(3661)).toBe('01:01:01');
  });

  it('handles negative values (clamps to 0)', () => {
    expect(formatTime(-10)).toBe('00:00:00');
  });

  it('formats large values', () => {
    expect(formatTime(86400)).toBe('24:00:00');
  });
});

describe('getFullImageUrl', () => {
  it('returns full URL for relative path', () => {
    expect(getFullImageUrl('/images/test.png')).toBe('https://app.automatonsoft.de/images/test.png');
  });

  it('returns URL as-is for absolute URL', () => {
    expect(getFullImageUrl('https://example.com/image.png')).toBe('https://example.com/image.png');
  });

  it('handles http URLs', () => {
    expect(getFullImageUrl('http://example.com/img.jpg')).toBe('http://example.com/img.jpg');
  });
});

describe('formatDate', () => {
  it('formats timestamp correctly', () => {
    const timestamp = 1640995200; // 2022-01-01 00:00:00 UTC
    const formatted = formatDate(timestamp);
    expect(formatted).toContain('2022');
  });

  it('handles zero timestamp', () => {
    const formatted = formatDate(0);
    expect(typeof formatted).toBe('string');
    expect(formatted.length).toBeGreaterThan(0);
  });
});

describe('getEntityTypeLabel', () => {
  it('returns label for known entity types', () => {
    expect(getEntityTypeLabel('time_entry_start')).toBe('Старт трекера');
    expect(getEntityTypeLabel('time_entry_pause')).toBe('Пауза');
    expect(getEntityTypeLabel('time_entry_resume')).toBe('Возобновление');
    expect(getEntityTypeLabel('time_entry_stop')).toBe('Остановка');
    expect(getEntityTypeLabel('screenshot')).toBe('Скриншот');
    expect(getEntityTypeLabel('activity')).toBe('Активность');
  });

  it('returns entityType as-is for unknown types', () => {
    expect(getEntityTypeLabel('unknown_type')).toBe('unknown_type');
  });
});

describe('getPayloadPreview', () => {
  it('removes sensitive fields from JSON payload', () => {
    const payload = JSON.stringify({
      projectId: 'p1',
      accessToken: 'secret',
      refreshToken: 'secret2',
      _encrypted: 'data',
      imageData: 'large',
      safeField: 'value',
    });
    const preview = getPayloadPreview(payload);
    const parsed = JSON.parse(preview);
    expect(parsed.accessToken).toBeUndefined();
    expect(parsed.refreshToken).toBeUndefined();
    expect(parsed._encrypted).toBeUndefined();
    expect(parsed.imageData).toBeUndefined();
    expect(parsed.safeField).toBe('value');
  });

  it('returns truncated string for invalid JSON', () => {
    const invalidPayload = 'not json{';
    const preview = getPayloadPreview(invalidPayload);
    expect(preview).toBe('not json{...');
    expect(preview.length).toBeLessThanOrEqual(103);
  });

  it('handles empty JSON', () => {
    const preview = getPayloadPreview('{}');
    expect(preview).toBe('{}');
  });

  it('handles payload longer than 100 chars (invalid JSON)', () => {
    const longPayload = 'a'.repeat(150);
    const preview = getPayloadPreview(longPayload);
    expect(preview).toBe('a'.repeat(100) + '...');
  });
});
