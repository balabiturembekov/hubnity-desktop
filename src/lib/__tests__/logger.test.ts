/**
 * Unit тесты для logger
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '../logger';

const mockCaptureException = vi.fn();

vi.mock('../sentry', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

describe('logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('debug logs in dev mode', () => {
    logger.debug('TEST', 'Debug message', { data: 1 });
    expect(console.debug).toHaveBeenCalled();
  });

  it('info logs message', () => {
    logger.info('TEST', 'Info message');
    expect(console.info).toHaveBeenCalled();
  });

  it('warn logs warning', () => {
    logger.warn('TEST', 'Warning message');
    expect(console.warn).toHaveBeenCalled();
  });

  it('error logs error and sends to Sentry', () => {
    const error = new Error('Test error');
    logger.error('TEST', 'Error message', error);
    expect(console.error).toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(error, expect.objectContaining({
      logger: expect.objectContaining({ context: 'TEST' }),
    }));
  });

  it('logError logs error with context', () => {
    const error = new Error('Test');
    logger.logError('TEST', error, 'Additional info');
    expect(console.error).toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalled();
  });

  it('safeLogToRust handles invoke gracefully', async () => {
    const mockInvoke = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.doMock('@tauri-apps/api/core', () => ({
      invoke: mockInvoke,
    }));
    // Должно не упасть даже при ошибке
    await expect(logger.safeLogToRust('Test message')).resolves.not.toThrow();
  });
});
