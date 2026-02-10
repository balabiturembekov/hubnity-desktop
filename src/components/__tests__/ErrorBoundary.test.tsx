/**
 * Unit тесты для ErrorBoundary
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBoundary } from '../ErrorBoundary';

vi.mock('../../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../lib/sentry', () => ({
  setSentryContext: vi.fn(),
  captureException: vi.fn(),
}));

const Throw = ({ message }: { message: string }) => {
  throw new Error(message);
};

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('renders children when there is no error', () => {
    render(
      <ErrorBoundary>
        <span>Child content</span>
      </ErrorBoundary>
    );
    expect(screen.getByText('Child content')).toBeInTheDocument();
  });

  it('renders fallback UI when child throws', () => {
    render(
      <ErrorBoundary>
        <Throw message="Test error" />
      </ErrorBoundary>
    );
    expect(screen.getByText(/Произошла ошибка/i)).toBeInTheDocument();
    expect(screen.getByText(/Приложение столкнулось с неожиданной ошибкой/i)).toBeInTheDocument();
  });

  it('renders custom fallback when provided', () => {
    render(
      <ErrorBoundary fallback={<div>Custom fallback</div>}>
        <Throw message="Boom" />
      </ErrorBoundary>
    );
    expect(screen.getByText('Custom fallback')).toBeInTheDocument();
    expect(screen.queryByText(/Произошла ошибка/i)).not.toBeInTheDocument();
  });

  it('shows Перезапустить button and it is clickable', async () => {
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <Throw message="Err" />
      </ErrorBoundary>
    );
    const resetBtn = screen.getByRole('button', { name: /перезапустить/i });
    expect(resetBtn).toBeInTheDocument();
    await user.click(resetBtn);
    expect(screen.getByRole('button', { name: /перезапустить/i })).toBeInTheDocument();
  });

  it('has Обновить страницу button', () => {
    render(
      <ErrorBoundary>
        <Throw message="Err" />
      </ErrorBoundary>
    );
    expect(screen.getByRole('button', { name: /обновить страницу/i })).toBeInTheDocument();
  });
});
