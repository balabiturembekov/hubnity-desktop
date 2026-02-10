/**
 * Unit тесты для sentry функций
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setSentryUser, clearSentryUser, setSentryContext, captureException, captureMessage } from '../sentry';

const mockSetUser = vi.fn();
const mockSetContext = vi.fn();
const mockCaptureException = vi.fn();
const mockCaptureMessage = vi.fn();
const mockWithScope = vi.fn((callback) => {
  const scope = {
    setContext: mockSetContext,
  };
  callback(scope);
});

vi.mock('@sentry/react', () => ({
  setUser: (...args: unknown[]) => mockSetUser(...args),
  setContext: (...args: unknown[]) => mockSetContext(...args),
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
  withScope: (callback: (scope: unknown) => void) => mockWithScope(callback),
}));

describe('sentry functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('setSentryUser calls Sentry.setUser', () => {
    setSentryUser({ id: '1', email: 'test@example.com' });
    expect(mockSetUser).toHaveBeenCalledWith({ id: '1', email: 'test@example.com' });
  });

  it('clearSentryUser calls Sentry.setUser with null', () => {
    clearSentryUser();
    expect(mockSetUser).toHaveBeenCalledWith(null);
  });

  it('setSentryContext calls Sentry.setContext', () => {
    setSentryContext('key', { value: 'test' });
    expect(mockSetContext).toHaveBeenCalledWith('key', { value: 'test' });
  });

  it('captureException calls Sentry.captureException without context', () => {
    const error = new Error('Test');
    captureException(error);
    expect(mockCaptureException).toHaveBeenCalledWith(error);
  });

  it('captureException uses withScope when context provided', () => {
    const error = new Error('Test');
    captureException(error, { test: 'value' });
    expect(mockWithScope).toHaveBeenCalled();
    expect(mockSetContext).toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(error);
  });

  it('captureMessage calls Sentry.captureMessage', () => {
    captureMessage('Test message', 'error');
    expect(mockCaptureMessage).toHaveBeenCalledWith('Test message', 'error');
  });
});
