/**
 * Unit тесты для useAuthStore
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuthStore } from '../useAuthStore';

const mockApiLogin = vi.fn();
const mockApiLogout = vi.fn();
const mockApiSetToken = vi.fn();
const mockApiClearToken = vi.fn();
const mockApiGetAccessToken = vi.fn();
const mockInvoke = vi.fn();
const mockSetCurrentUser = vi.fn();
const mockSetSentryUser = vi.fn();
const mockClearSentryUser = vi.fn();

vi.mock('../../lib/api', () => ({
  api: {
    login: (...args: unknown[]) => mockApiLogin(...args),
    logout: (...args: unknown[]) => mockApiLogout(...args),
    setToken: (...args: unknown[]) => mockApiSetToken(...args),
    clearToken: (...args: unknown[]) => mockApiClearToken(...args),
    getAccessToken: () => mockApiGetAccessToken(),
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('../../lib/current-user', () => ({
  setCurrentUser: (...args: unknown[]) => mockSetCurrentUser(...args),
}));

vi.mock('../../lib/sentry', () => ({
  setSentryUser: (...args: unknown[]) => mockSetSentryUser(...args),
  clearSentryUser: (...args: unknown[]) => mockClearSentryUser(...args),
}));

vi.mock('../../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../useTrackerStore', () => ({
  useTrackerStore: {
    getState: () => ({ reset: vi.fn().mockResolvedValue(undefined) }),
  },
}));

describe('useAuthStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(undefined);
    mockApiGetAccessToken.mockReturnValue(null);
    useAuthStore.setState({ user: null, isAuthenticated: false });
  });

  it('has initial state unauthenticated', () => {
    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.user).toBeNull();
  });

  it('login sets user and tokens on success', async () => {
    const user = { id: '1', name: 'Test', email: 'test@example.com' };
    mockApiLogin.mockResolvedValue({
      access_token: 'access',
      refresh_token: 'refresh',
      user,
    });
    mockInvoke.mockResolvedValue(undefined);

    await useAuthStore.getState().login({
      email: 'test@example.com',
      password: 'pass',
    });

    expect(mockApiSetToken).toHaveBeenCalledWith('access');
    expect(localStorage.getItem('refresh_token')).toBe('refresh');
    expect(mockSetCurrentUser).toHaveBeenCalledWith(user);
    expect(mockSetSentryUser).toHaveBeenCalledWith({ id: user.id, email: user.email });
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().user).toEqual(user);
  });

  it('login clears token and rethrows on API error', async () => {
    mockApiLogin.mockRejectedValue(new Error('Invalid credentials'));

    await expect(
      useAuthStore.getState().login({ email: 'a@b.com', password: 'x' })
    ).rejects.toThrow('Invalid credentials');

    expect(mockApiClearToken).toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('logout clears tokens and state', async () => {
    useAuthStore.setState({
      user: { 
        id: '1', 
        name: 'U', 
        email: 'u@u.com',
        role: 'user',
        status: 'active',
        avatar: '',
        hourlyRate: 0,
        companyId: 'c1',
        company: { id: 'c1', name: 'Company' },
      },
      isAuthenticated: true,
    });
    localStorage.setItem('refresh_token', 'ref');
    mockApiGetAccessToken.mockReturnValue('acc');
    mockApiLogout.mockResolvedValue(undefined);
    mockInvoke.mockResolvedValue(undefined);

    await useAuthStore.getState().logout();

    expect(mockApiLogout).toHaveBeenCalledWith('ref');
    expect(mockSetCurrentUser).toHaveBeenCalledWith(null);
    expect(mockApiClearToken).toHaveBeenCalled();
    expect(localStorage.getItem('refresh_token')).toBeNull();
    expect(mockClearSentryUser).toHaveBeenCalled();
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('clearTokens clears state without requiring access token', async () => {
    mockApiGetAccessToken.mockReturnValue(null);
    mockInvoke.mockResolvedValue(undefined);
    localStorage.setItem('refresh_token', 'x');

    await useAuthStore.getState().clearTokens();

    expect(mockSetCurrentUser).toHaveBeenCalledWith(null);
    expect(mockApiClearToken).toHaveBeenCalled();
    expect(localStorage.getItem('refresh_token')).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });
});
