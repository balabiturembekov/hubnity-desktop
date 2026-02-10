/**
 * Unit тесты для Settings
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Settings } from '../Settings';

const hoisted = vi.hoisted(() => ({
  mockSetIdleThreshold: vi.fn(),
  mockInvoke: vi.fn(),
  mockLogout: vi.fn(),
}));

const mockUseTrackerStoreState = {
  idleThreshold: 2,
  setIdleThreshold: hoisted.mockSetIdleThreshold,
};

vi.mock('../../store/useTrackerStore', () => ({
  useTrackerStore: Object.assign(
    (selector: (s: typeof mockUseTrackerStoreState) => unknown) => {
      return selector ? selector(mockUseTrackerStoreState) : mockUseTrackerStoreState;
    },
    { getState: () => ({ reset: vi.fn().mockResolvedValue(undefined) }) }
  ),
}));

let mockUserRole = 'owner';

vi.mock('../../store/useAuthStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => {
    const state = {
      logout: hoisted.mockLogout,
      user: { id: '1', name: 'U', email: 'u@u.com', role: mockUserRole, company: { name: 'Company' } },
    };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return {
    ...actual,
    api: { getAccessToken: () => 'token' },
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => hoisted.mockInvoke(...args),
}));

vi.mock('../../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), safeLogToRust: vi.fn().mockResolvedValue(undefined) },
}));

describe('Settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserRole = 'owner'; // Сбрасываем роль на owner по умолчанию
    hoisted.mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_sync_queue_stats') {
        return Promise.resolve({ pending_count: 0, failed_count: 0, sent_count: 0, pending_by_type: {} });
      }
      if (cmd === 'set_auth_tokens') {
        return Promise.resolve(undefined);
      }
      if (cmd === 'show_notification') {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });
    hoisted.mockLogout.mockResolvedValue(undefined);
  });

  it('renders settings and idle threshold input', async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByLabelText(/порог неактивности/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /сохранить/i })).toBeInTheDocument();
  });

  it('saves idle threshold on Save click', async () => {
    const user = userEvent.setup();
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByLabelText(/порог неактивности/i)).toBeInTheDocument();
    });
    const input = screen.getByLabelText(/порог неактивности/i) as HTMLInputElement;
    // Изменяем значение, чтобы кнопка стала активна (threshold !== idleThreshold)
    await user.clear(input);
    await user.type(input, '3');
    // Ждем, пока состояние обновится и кнопка станет активной
    await waitFor(async () => {
      const saveBtn = screen.getByRole('button', { name: /сохранить/i });
      if (saveBtn.hasAttribute('disabled')) {
        throw new Error('Button still disabled');
      }
    }, { timeout: 2000 });
    const saveBtn = screen.getByRole('button', { name: /сохранить/i });
    expect(saveBtn).not.toBeDisabled();
    await user.click(saveBtn);
    // Ждем вызова setIdleThreshold
    await waitFor(() => {
      expect(hoisted.mockSetIdleThreshold).toHaveBeenCalled();
    }, { timeout: 5000 });
    // Проверяем, что вызвано с валидным значением (Math.max(1, Math.floor(value)) >= 1)
    expect(hoisted.mockSetIdleThreshold).toHaveBeenCalledWith(expect.any(Number));
    const calls = hoisted.mockSetIdleThreshold.mock.calls;
    expect(calls[calls.length - 1][0]).toBeGreaterThanOrEqual(1);
  });

  it('shows access denied message for non-admin users', async () => {
    // Устанавливаем роль 'user' (не owner/admin)
    mockUserRole = 'user';

    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText(/нет доступа к настройкам/i)).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/порог неактивности/i)).not.toBeInTheDocument();
  });
});
