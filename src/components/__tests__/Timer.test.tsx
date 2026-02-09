/**
 * PRODUCTION: Unit тесты для Timer компонента
 * 
 * Покрытие:
 * - Basic render: компонент рендерится
 * - State change: отображение состояния таймера
 * - Button interactions: start/stop/pause/resume
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Timer } from '../Timer';

// Hoist mocks so they exist when vi.mock factories run
const hoisted = vi.hoisted(() => {
  const defaultTimerState = {
    state: 'STOPPED' as const,
    elapsed_seconds: 0,
    accumulated_seconds: 0,
    session_start: null,
    day_start: Math.floor(Date.now() / 1000),
  };
  const defaultProject = { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' };
  return {
    mockStartTracking: vi.fn(),
    mockStopTracking: vi.fn(),
    mockPauseTracking: vi.fn(),
    mockResumeTracking: vi.fn(),
    mockGetState: vi.fn(),
    mockSetState: vi.fn(),
    mockInvoke: vi.fn(),
    defaultTimerState,
    defaultProject,
    getTimerStateImpl: { current: () => Promise.resolve(defaultTimerState) as Promise<typeof defaultTimerState> },
  };
});

vi.mock('../../store/useTrackerStore', () => {
  const state = {
    selectedProject: hoisted.defaultProject,
    isTracking: false,
    isPaused: false,
    currentTimeEntry: null,
    isLoading: false,
    error: null,
    isTakingScreenshot: false,
    idlePauseStartTime: null,
    startTracking: hoisted.mockStartTracking,
    stopTracking: hoisted.mockStopTracking,
    pauseTracking: hoisted.mockPauseTracking,
    resumeTracking: hoisted.mockResumeTracking,
    getTimerState: () => hoisted.getTimerStateImpl.current(),
    resetDay: () => hoisted.getTimerStateImpl.current(),
    setState: hoisted.mockSetState,
  };
  return {
    useTrackerStore: Object.assign(
      vi.fn((selector: any) => (selector ? selector(state) : state)),
      { getState: () => state }
    ),
  };
});

vi.mock('../../lib/timer-engine', () => ({
  TimerEngineAPI: {
    getState: (...args: any[]) => hoisted.mockGetState(...args),
    resetDay: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../lib/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => hoisted.mockInvoke(...args),
}));

describe('Timer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.mockInvoke.mockResolvedValue(undefined);
    hoisted.mockSetState.mockImplementation(() => {});
    hoisted.getTimerStateImpl.current = () => hoisted.mockGetState();
    hoisted.mockGetState.mockResolvedValue({
      state: 'STOPPED',
      elapsed_seconds: 0,
      accumulated_seconds: 0,
      session_start: null,
      day_start: Math.floor(Date.now() / 1000),
    });
  });

  it('renders timer component', async () => {
    // Mock getState to return STOPPED state immediately
    const stoppedState = {
      state: 'STOPPED' as const,
      elapsed_seconds: 0,
      accumulated_seconds: 0,
      session_start: null,
      day_start: Math.floor(Date.now() / 1000),
    };
    
    // Ensure mock is set before render
    hoisted.mockGetState.mockResolvedValue(stoppedState);
    
    render(<Timer />);
    
    // Wait for useEffect to complete and state to update
    // Timer component shows "00:00:00" when timerState is null or STOPPED
    await waitFor(() => {
      // Try multiple ways to find the text
      const timerText = screen.queryByText(/00:00:00/i) || 
                       screen.queryByText((_content, element) => {
                         return element?.textContent === '00:00:00';
                       });
      expect(timerText).toBeInTheDocument();
    }, { timeout: 5000 });
  });

  it('displays elapsed time from timer engine', async () => {
    // Mock getState to return RUNNING state with elapsed time
    const runningState = {
      state: 'RUNNING' as const,
      started_at: Date.now() / 1000,
      elapsed_seconds: 3661, // 1 hour, 1 minute, 1 second
      accumulated_seconds: 3661,
      session_start: Date.now() / 1000,
      day_start: Math.floor(Date.now() / 1000),
    };
    
    // Ensure mock is set before render
    hoisted.mockGetState.mockResolvedValue(runningState);
    
    render(<Timer />);
    
    // Wait for useEffect to complete and state to update
    await waitFor(() => {
      // Try multiple ways to find the text
      const timerText = screen.queryByText(/01:01:01/i) || 
                       screen.queryByText((_content, element) => {
                         return element?.textContent === '01:01:01';
                       });
      expect(timerText).toBeInTheDocument();
    }, { timeout: 5000 });
  });

  it('shows start button when stopped', async () => {
    const { useTrackerStore } = await import('../../store/useTrackerStore');
    vi.mocked(useTrackerStore).mockImplementation((selector: any) => {
      const state = {
        selectedProject: { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' },
        isTracking: false,
        isPaused: false,
        currentTimeEntry: null,
        isLoading: false,
        error: null,
        isTakingScreenshot: false,
        idlePauseStartTime: null,
        startTracking: hoisted.mockStartTracking,
        stopTracking: hoisted.mockStopTracking,
        pauseTracking: hoisted.mockPauseTracking,
        resumeTracking: hoisted.mockResumeTracking,
      };
      return selector ? selector(state) : state;
    });
    
    await act(async () => {
      render(<Timer />);
    });
    
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /старт/i })).toBeInTheDocument();
    });
  });

  it('shows pause button when running', async () => {
    const { useTrackerStore } = await import('../../store/useTrackerStore');
    vi.mocked(useTrackerStore).mockImplementation((selector: any) => {
      const state = {
        selectedProject: { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' },
        isTracking: true,
        isPaused: false,
        currentTimeEntry: { id: '1' },
        isLoading: false,
        error: null,
        isTakingScreenshot: false,
        idlePauseStartTime: null,
        startTracking: hoisted.mockStartTracking,
        stopTracking: hoisted.mockStopTracking,
        pauseTracking: hoisted.mockPauseTracking,
        resumeTracking: hoisted.mockResumeTracking,
      };
      return selector ? selector(state) : state;
    });
    
    hoisted.mockGetState.mockResolvedValue({
      state: 'RUNNING',
      started_at: Date.now() / 1000,
      elapsed_seconds: 0,
      accumulated_seconds: 0,
      session_start: Date.now() / 1000,
      day_start: Math.floor(Date.now() / 1000),
    });
    
    await act(async () => {
      render(<Timer />);
    });
    
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /пауза/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /стоп/i })).toBeInTheDocument();
    });
  });

  it('shows resume button when paused', async () => {
    const { useTrackerStore } = await import('../../store/useTrackerStore');
    vi.mocked(useTrackerStore).mockImplementation((selector: any) => {
      const state = {
        selectedProject: { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' },
        isTracking: true,
        isPaused: true,
        currentTimeEntry: { id: '1' },
        isLoading: false,
        error: null,
        isTakingScreenshot: false,
        idlePauseStartTime: null,
        startTracking: hoisted.mockStartTracking,
        stopTracking: hoisted.mockStopTracking,
        pauseTracking: hoisted.mockPauseTracking,
        resumeTracking: hoisted.mockResumeTracking,
      };
      return selector ? selector(state) : state;
    });
    
    hoisted.mockGetState.mockResolvedValue({
      state: 'PAUSED',
      elapsed_seconds: 0,
      accumulated_seconds: 0,
      session_start: null,
      day_start: Math.floor(Date.now() / 1000),
    });
    
    await act(async () => {
      render(<Timer />);
    });
    
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /возобновить/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /стоп/i })).toBeInTheDocument();
    });
  });

  it('calls startTracking when start button is clicked', async () => {
    const user = userEvent.setup();
    const { useTrackerStore } = await import('../../store/useTrackerStore');
    
    vi.mocked(useTrackerStore).mockImplementation((selector: any) => {
      const state = {
        selectedProject: { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' },
        isTracking: false,
        isPaused: false,
        currentTimeEntry: null,
        isLoading: false,
        error: null,
        isTakingScreenshot: false,
        idlePauseStartTime: null,
        startTracking: hoisted.mockStartTracking,
        stopTracking: hoisted.mockStopTracking,
        pauseTracking: hoisted.mockPauseTracking,
        resumeTracking: hoisted.mockResumeTracking,
      };
      return selector ? selector(state) : state;
    });
    
    hoisted.mockStartTracking.mockResolvedValue(undefined);
    
    await act(async () => {
      render(<Timer />);
    });
    
    await waitFor(async () => {
      const startButton = screen.getByRole('button', { name: /старт/i });
      await user.click(startButton);
    });
    
    await waitFor(() => {
      expect(hoisted.mockStartTracking).toHaveBeenCalled();
    });
  });

  it('calls pauseTracking when pause button is clicked', async () => {
    const user = userEvent.setup();
    const { useTrackerStore } = await import('../../store/useTrackerStore');
    
    vi.mocked(useTrackerStore).mockImplementation((selector: any) => {
      const state = {
        selectedProject: { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' },
        isTracking: true,
        isPaused: false,
        currentTimeEntry: { id: '1' },
        isLoading: false,
        error: null,
        isTakingScreenshot: false,
        idlePauseStartTime: null,
        startTracking: hoisted.mockStartTracking,
        stopTracking: hoisted.mockStopTracking,
        pauseTracking: hoisted.mockPauseTracking,
        resumeTracking: hoisted.mockResumeTracking,
        getState: () => state,
        setState: hoisted.mockSetState,
      };
      return selector ? selector(state) : state;
    });
    
    const runningState = {
      state: 'RUNNING' as const,
      started_at: Date.now() / 1000,
      elapsed_seconds: 0,
      accumulated_seconds: 0,
      session_start: Date.now() / 1000,
      day_start: Math.floor(Date.now() / 1000),
    };
    
    hoisted.mockGetState.mockResolvedValue(runningState);
    hoisted.mockPauseTracking.mockResolvedValue(undefined);
    
    await act(async () => {
      render(<Timer />);
    });
    
    // Wait for timer state to update and buttons to render
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /пауза/i })).toBeInTheDocument();
    }, { timeout: 3000 });
    
    const pauseButton = screen.getByRole('button', { name: /пауза/i });
    await act(async () => {
      await user.click(pauseButton);
    });
    
    await waitFor(() => {
      expect(hoisted.mockPauseTracking).toHaveBeenCalled();
    });
  });

  it('calls resumeTracking when resume button is clicked', async () => {
    const user = userEvent.setup();
    const { useTrackerStore } = await import('../../store/useTrackerStore');
    
    vi.mocked(useTrackerStore).mockImplementation((selector: any) => {
      const state = {
        selectedProject: { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' },
        isTracking: true,
        isPaused: true,
        currentTimeEntry: { id: '1' },
        isLoading: false,
        error: null,
        isTakingScreenshot: false,
        idlePauseStartTime: null,
        startTracking: hoisted.mockStartTracking,
        stopTracking: hoisted.mockStopTracking,
        pauseTracking: hoisted.mockPauseTracking,
        resumeTracking: hoisted.mockResumeTracking,
      };
      return selector ? selector(state) : state;
    });
    
    hoisted.mockGetState.mockResolvedValue({
      state: 'PAUSED',
      elapsed_seconds: 0,
      accumulated_seconds: 0,
      session_start: null,
      day_start: Math.floor(Date.now() / 1000),
    });
    
    hoisted.mockResumeTracking.mockResolvedValue(undefined);
    
    await act(async () => {
      render(<Timer />);
    });
    
    // Wait for timer state to update and buttons to render
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /возобновить/i })).toBeInTheDocument();
    }, { timeout: 5000 });
    
    const resumeButton = screen.getByRole('button', { name: /возобновить/i });
    await user.click(resumeButton);
    
    await waitFor(() => {
      expect(hoisted.mockResumeTracking).toHaveBeenCalled();
    });
  });

  it('calls stopTracking when stop button is clicked', async () => {
    const user = userEvent.setup();
    const { useTrackerStore } = await import('../../store/useTrackerStore');
    
    vi.mocked(useTrackerStore).mockImplementation((selector: any) => {
      const state = {
        selectedProject: { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' },
        isTracking: true,
        isPaused: false,
        currentTimeEntry: { id: '1' },
        isLoading: false,
        error: null,
        isTakingScreenshot: false,
        idlePauseStartTime: null,
        startTracking: hoisted.mockStartTracking,
        stopTracking: hoisted.mockStopTracking,
        pauseTracking: hoisted.mockPauseTracking,
        resumeTracking: hoisted.mockResumeTracking,
      };
      return selector ? selector(state) : state;
    });
    
    hoisted.mockGetState.mockResolvedValue({
      state: 'RUNNING',
      started_at: Date.now() / 1000,
      elapsed_seconds: 0,
      accumulated_seconds: 0,
      session_start: Date.now() / 1000,
      day_start: Math.floor(Date.now() / 1000),
    });
    
    hoisted.mockStopTracking.mockResolvedValue(undefined);
    
    await act(async () => {
      render(<Timer />);
    });
    
    // Wait for timer state to update and buttons to render
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /стоп/i })).toBeInTheDocument();
    }, { timeout: 5000 });
    
    const stopButton = screen.getByRole('button', { name: /стоп/i });
    await user.click(stopButton);
    
    await waitFor(() => {
      expect(hoisted.mockStopTracking).toHaveBeenCalled();
    });
  });
});
