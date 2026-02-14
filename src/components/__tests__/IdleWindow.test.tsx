/**
 * Unit тесты для IdleWindow
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IdleWindow } from '../IdleWindow';

const mockListen = vi.fn();
const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('../../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe('IdleWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(undefined);
    mockListen.mockResolvedValue(() => {});
  });

  it('renders idle alert and buttons', () => {
    render(<IdleWindow />);
    expect(screen.getByText('Idle time alert')).toBeInTheDocument();
    expect(screen.getByText(/You have been idle for/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resume timer/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop timer/i })).toBeInTheDocument();
  });

  it('shows 0 minutes initially (Hubstaff-style format)', () => {
    render(<IdleWindow />);
    expect(screen.getByText('0 minutes')).toBeInTheDocument();
  });

  it('calls resume_tracking_from_idle when Resume timer clicked', async () => {
    const user = userEvent.setup();
    render(<IdleWindow />);
    await user.click(screen.getByRole('button', { name: /resume timer/i }));
    expect(mockInvoke).toHaveBeenCalledWith('resume_tracking_from_idle');
  });

  it('calls stop_tracking_from_idle when Stop timer clicked', async () => {
    const user = userEvent.setup();
    render(<IdleWindow />);
    await user.click(screen.getByRole('button', { name: /stop timer/i }));
    expect(mockInvoke).toHaveBeenCalledWith('stop_tracking_from_idle');
  });
});
