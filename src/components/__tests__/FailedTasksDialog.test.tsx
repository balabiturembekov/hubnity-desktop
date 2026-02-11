/**
 * Unit тесты для FailedTasksDialog
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FailedTasksDialog } from '../FailedTasksDialog';

const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('../../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe('FailedTasksDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(0);
  });

  it('does not render content when open is false', () => {
    render(
      <FailedTasksDialog open={false} onOpenChange={vi.fn()} failedCount={0} onRetry={vi.fn()} />
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('loads failed tasks when open', async () => {
    const tasks = [
      { id: 1, entity_type: 'time_entry_stop', payload: '{}', retry_count: 2, created_at: 1000, last_retry_at: 1001, error_message: 'Network error' },
    ];
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_failed_tasks') return Promise.resolve(tasks);
      return Promise.resolve(0);
    });
    render(
      <FailedTasksDialog open={true} onOpenChange={vi.fn()} failedCount={1} onRetry={vi.fn()} />
    );
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('get_failed_tasks', { limit: 50 });
    });
    await waitFor(() => {
      expect(screen.getByText(/Stop/i)).toBeInTheDocument();
    });
  });

  it('calls retry_failed_tasks and onRetry when Retry all clicked', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_failed_tasks') return Promise.resolve([]);
      if (cmd === 'retry_failed_tasks') return Promise.resolve(3);
      return Promise.resolve();
    });
    const onRetry = vi.fn();
    render(
      <FailedTasksDialog open={true} onOpenChange={vi.fn()} failedCount={2} onRetry={onRetry} />
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /retry all/i })).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /retry all/i }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('retry_failed_tasks', { limit: 100 });
      expect(onRetry).toHaveBeenCalled();
    });
  });
});
