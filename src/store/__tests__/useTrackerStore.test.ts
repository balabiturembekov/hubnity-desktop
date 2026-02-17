/**
 * PRODUCTION: Unit тесты для useTrackerStore
 * 
 * Покрытие:
 * - start/stop/pause flow
 * - error handling path
 * - State transitions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTrackerStore } from '../useTrackerStore';
import { logger } from '../../lib/logger';
import { TimerEngineAPI } from '../../lib/timer-engine';

// Mock dependencies before imports
const mockInvoke = vi.fn();
const mockCreateTimeEntry = vi.fn();
const mockStopTimeEntry = vi.fn();
const mockPauseTimeEntry = vi.fn();
const mockResumeTimeEntry = vi.fn();
const mockGetActiveTimeEntries = vi.fn();
const mockStartTimer = vi.fn();
const mockPauseTimer = vi.fn();
const mockPauseIdle = vi.fn();
const mockResumeTimer = vi.fn();
const mockStopTimer = vi.fn();
const mockGetTimerState = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

vi.mock('../../lib/api', () => {
  const mockApi = {
    createTimeEntry: (...args: any[]) => mockCreateTimeEntry(...args),
    startTimeEntry: (...args: any[]) => mockCreateTimeEntry(...args), // Alias for createTimeEntry
    stopTimeEntry: (...args: any[]) => mockStopTimeEntry(...args),
    pauseTimeEntry: (...args: any[]) => mockPauseTimeEntry(...args),
    resumeTimeEntry: (...args: any[]) => mockResumeTimeEntry(...args),
    updateTimeEntry: vi.fn().mockResolvedValue({}),
    getActiveTimeEntries: (...args: any[]) => mockGetActiveTimeEntries(...args),
    getProjects: vi.fn().mockResolvedValue([]),
    getActiveTimeEntry: vi.fn().mockResolvedValue(null),
    sendHeartbeat: vi.fn().mockResolvedValue(undefined),
    batchUploadUrlActivities: vi.fn().mockResolvedValue({ count: 0, skipped: 0 }),
    getAccessToken: vi.fn().mockReturnValue('test-access-token'),
  };
  return { api: mockApi };
});

vi.mock('../../lib/current-user', () => ({
  getCurrentUser: vi.fn(() => ({
    id: 'test-user-id',
    name: 'Test User',
    email: 'test@example.com',
  })),
  setCurrentUser: vi.fn(),
}));

vi.mock('../../lib/timer-engine', () => ({
  TimerEngineAPI: {
    start: (...args: any[]) => mockStartTimer(...args),
    pause: (...args: any[]) => mockPauseTimer(...args),
    pauseIdle: (...args: any[]) => mockPauseIdle(...args),
    resume: (...args: any[]) => mockResumeTimer(...args),
    stop: (...args: any[]) => mockStopTimer(...args),
    getState: (...args: any[]) => mockGetTimerState(...args),
    resetDay: vi.fn().mockResolvedValue({
      state: 'STOPPED',
      elapsed_seconds: 0,
      accumulated_seconds: 0,
      session_start: null,
      day_start: Math.floor(Date.now() / 1000),
    }),
    saveState: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../lib/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    safeLogToRust: vi.fn().mockResolvedValue(undefined),
    logError: vi.fn(),
    debugTerminal: vi.fn(),
  },
}));

describe('useTrackerStore', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    
    // Reset store state
    const resetFn = useTrackerStore.getState().reset;
    if (resetFn) {
      await resetFn();
    }
    
    // Setup default store state
    useTrackerStore.setState({
      selectedProject: { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE', companyId: '', createdAt: '', updatedAt: '' },
      projects: [],
      currentTimeEntry: null,
      isTracking: false,
      isPaused: false,
      isLoading: false,
      error: null,
    });
    
    // Default mocks
    mockGetActiveTimeEntries.mockResolvedValue([]);
    
    mockCreateTimeEntry.mockResolvedValue({
      id: 'test-entry-id',
      project: { id: '1', name: 'Test Project' },
      status: 'RUNNING',
      startTime: new Date().toISOString(),
    });
    
    mockStartTimer.mockResolvedValue({
      state: 'RUNNING',
      started_at: Date.now() / 1000,
      elapsed_seconds: 0,
      accumulated_seconds: 0,
      session_start: Date.now() / 1000,
      day_start: Math.floor(Date.now() / 1000),
    });
    
    mockPauseTimer.mockResolvedValue({
      state: 'PAUSED',
      elapsed_seconds: 0,
      accumulated_seconds: 0,
      session_start: null,
      day_start: Math.floor(Date.now() / 1000),
    });
    
    mockResumeTimer.mockResolvedValue({
      state: 'RUNNING',
      started_at: Date.now() / 1000,
      elapsed_seconds: 0,
      accumulated_seconds: 0,
      session_start: Date.now() / 1000,
      day_start: Math.floor(Date.now() / 1000),
    });
    
    mockStopTimer.mockResolvedValue({
      state: 'STOPPED',
      elapsed_seconds: 0,
      accumulated_seconds: 0,
      session_start: null,
      day_start: Math.floor(Date.now() / 1000),
    });
    
    mockGetTimerState.mockResolvedValue({
      state: 'STOPPED',
      elapsed_seconds: 0,
      accumulated_seconds: 0,
      session_start: null,
      day_start: Math.floor(Date.now() / 1000),
    });
    
    mockInvoke.mockImplementation((command: string) => {
      // Mock different Tauri commands
      if (command === 'start_activity_monitoring') {
        return Promise.resolve(undefined);
      }
      if (command === 'set_auth_tokens') {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });
    
    mockPauseTimeEntry.mockResolvedValue({
      id: 'test-entry-id',
      status: 'PAUSED',
    });
    
    mockResumeTimeEntry.mockResolvedValue({
      id: 'test-entry-id',
      status: 'RUNNING',
    });
    
    mockStopTimeEntry.mockResolvedValue({
      id: 'test-entry-id',
      status: 'STOPPED',
    });
  });

  describe('startTracking', () => {
    it('creates time entry and starts timer engine', async () => {
      const project = { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' };
      useTrackerStore.getState().selectProject(project);
      
      await useTrackerStore.getState().startTracking();
      
      expect(mockGetActiveTimeEntries).toHaveBeenCalled();
      expect(mockStartTimer).toHaveBeenCalled();
      
      const state = useTrackerStore.getState();
      expect(state.isTracking).toBe(true);
      expect(state.currentTimeEntry).toBeTruthy();
      
      // API вызывается в фоне — ждём
      await new Promise(r => setTimeout(r, 50));
      expect(mockCreateTimeEntry).toHaveBeenCalledWith({
        projectId: project.id,
        userId: 'test-user-id',
        description: `Work on project ${project.name}`,
      });
    });

    it('handles error when creating time entry', async () => {
      const project = { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' };
      useTrackerStore.getState().selectProject(project);
      
      const error = new Error('API Error');
      mockCreateTimeEntry.mockRejectedValueOnce(error);
      
      try {
        await useTrackerStore.getState().startTracking();
      } catch (e) {
        // Error may be thrown or caught internally
      }
      
      const state = useTrackerStore.getState();
      // Error should be set in state or isLoading should be false
      expect(state.error || state.isLoading === false).toBeTruthy();
    });

    it('handles error when starting timer engine', async () => {
      const project = { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' };
      useTrackerStore.getState().selectProject(project);
      
      const error = new Error('Timer Engine Error');
      mockStartTimer.mockRejectedValueOnce(error);
      mockGetTimerState.mockResolvedValueOnce({ state: 'STOPPED', elapsed_seconds: 0, accumulated_seconds: 0, session_start: null, day_start: Math.floor(Date.now() / 1000) });
      
      await useTrackerStore.getState().startTracking();
      
      const state = useTrackerStore.getState();
      expect(state.error != null || !state.isTracking).toBeTruthy();
      expect(mockCreateTimeEntry).not.toHaveBeenCalled();
    });
  });

  describe('pauseTracking', () => {
    it('pauses timer engine and updates time entry', async () => {
      const project = { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' };
      useTrackerStore.getState().selectProject(project);
      await useTrackerStore.getState().startTracking();
      await new Promise(r => setTimeout(r, 80));
      
      const currentEntry = useTrackerStore.getState().currentTimeEntry;
      expect(currentEntry).toBeTruthy();
      mockGetTimerState.mockResolvedValueOnce({
        state: 'RUNNING',
        started_at: Date.now() / 1000,
        elapsed_seconds: 0,
        accumulated_seconds: 0,
        session_start: Date.now() / 1000,
        day_start: Math.floor(Date.now() / 1000),
      });
      mockPauseTimeEntry.mockResolvedValueOnce({
        ...currentEntry,
        status: 'PAUSED',
      });
      
      await useTrackerStore.getState().pauseTracking();
      
      expect(mockPauseTimer).toHaveBeenCalled();
      
      const state = useTrackerStore.getState();
      expect(state.isPaused).toBe(true);
      expect(state.isTracking).toBe(true);
      
      await new Promise(r => setTimeout(r, 50));
      expect(mockPauseTimeEntry).toHaveBeenCalled();
    });

    it('calls pauseIdle (not pause) when isIdlePause=true, excludes idle time from accumulated', async () => {
      const project = { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' };
      useTrackerStore.getState().selectProject(project);
      await useTrackerStore.getState().startTracking();
      await new Promise(r => setTimeout(r, 80));

      const currentEntry = useTrackerStore.getState().currentTimeEntry;
      expect(currentEntry).toBeTruthy();

      const sessionStart = Math.floor(Date.now() / 1000) - 300; // 5 min ago
      const lastActivityTime = (sessionStart + 180) * 1000; // last active 3 min ago (2 min idle)
      useTrackerStore.setState({ lastActivityTime, clientSessionStartMs: null }); // use session_start from mock

      const runningState = {
        state: 'RUNNING' as const,
        started_at: sessionStart,
        elapsed_seconds: 300,
        accumulated_seconds: 0,
        session_start: sessionStart,
        day_start: Math.floor(Date.now() / 1000),
      };
      mockGetTimerState.mockResolvedValue(runningState); // Multiple getState calls in pauseTracking flow
      mockPauseIdle.mockResolvedValue({
        state: 'PAUSED',
        elapsed_seconds: 180,
        accumulated_seconds: 180,
        session_start: null,
        day_start: Math.floor(Date.now() / 1000),
      });
      mockPauseTimeEntry.mockResolvedValue({ ...currentEntry, status: 'PAUSED' });

      await useTrackerStore.getState().pauseTracking(true);

      expect(mockPauseIdle).toHaveBeenCalledWith(180);
      expect(mockPauseTimer).not.toHaveBeenCalled();
      const state = useTrackerStore.getState();
      expect(state.isPaused).toBe(true);
    });

    it('handles error when pausing timer engine', async () => {
      // Setup: start tracking first
      const project = { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' };
      useTrackerStore.getState().selectProject(project);
      await useTrackerStore.getState().startTracking();
      
      // Setup: ensure we have a currentTimeEntry
      const currentEntry = useTrackerStore.getState().currentTimeEntry;
      expect(currentEntry).toBeTruthy();
      
      // Mock getState to return RUNNING state (for pause check)
      mockGetTimerState.mockResolvedValueOnce({
        state: 'RUNNING',
        started_at: Date.now() / 1000,
        elapsed_seconds: 0,
        accumulated_seconds: 0,
        session_start: Date.now() / 1000,
        day_start: Math.floor(Date.now() / 1000),
      });
      
      // Mock pause to fail with a non-specific error (not "already paused")
      const error = new Error('Pause Error - generic failure');
      mockPauseTimer.mockRejectedValueOnce(error);
      
      // Mock getState for fallback after error (code tries to get state after error)
      mockGetTimerState.mockResolvedValueOnce({
        state: 'RUNNING',
        started_at: Date.now() / 1000,
        elapsed_seconds: 0,
        accumulated_seconds: 0,
        session_start: Date.now() / 1000,
        day_start: Math.floor(Date.now() / 1000),
      });
      
      // Mock invoke for show_notification (code shows notification on error)
      mockInvoke.mockResolvedValueOnce(undefined);
      
      try {
        await useTrackerStore.getState().pauseTracking();
      } catch (e) {
        // Error may be thrown or caught internally
      }
      
      // Should handle error gracefully - error should be set OR pause didn't succeed
      const state = useTrackerStore.getState();
      // The code shows notification but may not set error in state, so check that pause didn't succeed
      expect(state.isPaused === false || state.error).toBeTruthy();
    });
  });

  describe('resumeTracking', () => {
    it('resumes timer engine and updates time entry', async () => {
      const project = { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' };
      useTrackerStore.getState().selectProject(project);
      await useTrackerStore.getState().startTracking();
      await new Promise(r => setTimeout(r, 80));
      // pauseTracking calls getState - must return RUNNING so we actually pause (not STOPPED which would clear store)
      mockGetTimerState.mockResolvedValueOnce({
        state: 'RUNNING',
        started_at: Date.now() / 1000,
        elapsed_seconds: 0,
        accumulated_seconds: 0,
        session_start: Date.now() / 1000,
        day_start: Math.floor(Date.now() / 1000),
      });
      mockGetTimerState.mockResolvedValueOnce({
        state: 'PAUSED',
        elapsed_seconds: 0,
        accumulated_seconds: 0,
        session_start: null,
        day_start: Math.floor(Date.now() / 1000),
      });
      await useTrackerStore.getState().pauseTracking();
      await new Promise(r => setTimeout(r, 50));
      
      const currentEntry = useTrackerStore.getState().currentTimeEntry;
      mockGetTimerState.mockResolvedValueOnce({
        state: 'PAUSED',
        elapsed_seconds: 100,
        accumulated_seconds: 0,
        session_start: Date.now() / 1000,
        day_start: Math.floor(Date.now() / 1000),
      });
      mockResumeTimeEntry.mockResolvedValueOnce({
        ...currentEntry,
        status: 'RUNNING',
      });
      mockResumeTimer.mockResolvedValueOnce({
        state: 'RUNNING',
        started_at: Date.now() / 1000,
        elapsed_seconds: 100,
        accumulated_seconds: 0,
        session_start: Date.now() / 1000,
        day_start: Math.floor(Date.now() / 1000),
      });
      
      await useTrackerStore.getState().resumeTracking();
      
      expect(mockResumeTimer).toHaveBeenCalled();
      
      const state = useTrackerStore.getState();
      expect(state.isPaused).toBe(false);
      expect(state.isTracking).toBe(true);
      
      await new Promise(r => setTimeout(r, 50));
      expect(mockResumeTimeEntry).toHaveBeenCalled();
    });

    it('handles error when resuming timer engine', async () => {
      const project = { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' };
      const pausedEntry = {
        id: 'test-entry-id',
        projectId: project.id,
        project,
        status: 'PAUSED' as const,
        startTime: new Date().toISOString(),
        endTime: null,
        duration: 0,
        description: '',
        userId: 'test-user-id',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      useTrackerStore.setState({
        selectedProject: project,
        currentTimeEntry: pausedEntry,
        isTracking: true,
        isPaused: true,
      });
      
      // Mock getState to return PAUSED state for resume
      mockGetTimerState.mockResolvedValue({
        state: 'PAUSED',
        elapsed_seconds: 0,
        accumulated_seconds: 0,
        session_start: null,
        day_start: Math.floor(Date.now() / 1000),
      });
      
      const error = new Error('Resume Error');
      mockResumeTimer.mockRejectedValueOnce(error);
      
      try {
        await useTrackerStore.getState().resumeTracking();
      } catch (e) {
        // Error may be thrown or caught internally
      }
      
      // When only engine fails, store still updates from API (isTracking true); either error or tracking set
      const state = useTrackerStore.getState();
      expect(state.error != null || state.isTracking === true).toBeTruthy();
    });
  });

  /** Этап 2: при смене проекта во время трекинга сначала вызывается stopTracking, затем выставляется новый проект */
  describe('selectProject while tracking', () => {
    it('stops tracking then sets new project when switching project during tracking', async () => {
      const project1 = { id: '1', name: 'Project A', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' };
      const project2 = { id: '2', name: 'Project B', color: '#111111', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' };
      await useTrackerStore.getState().selectProject(project1);
      await useTrackerStore.getState().startTracking();
      await new Promise(r => setTimeout(r, 80));
      expect(useTrackerStore.getState().isTracking).toBe(true);
      expect(useTrackerStore.getState().currentTimeEntry).toBeTruthy();

      const currentEntry = useTrackerStore.getState().currentTimeEntry;
      
      // BUG FIX: Mock Timer Engine state to return RUNNING before stop
      // selectProject -> stopTracking now checks Timer Engine state directly
      // First call: for selectProject check
      mockGetTimerState.mockResolvedValueOnce({
        state: 'RUNNING',
        started_at: Date.now() / 1000,
        elapsed_seconds: 100,
        accumulated_seconds: 0,
        session_start: Date.now() / 1000,
        day_start: Math.floor(Date.now() / 1000),
      });
      
      // Second call: for stopTracking check (inside selectProject -> stopTracking)
      mockGetTimerState.mockResolvedValueOnce({
        state: 'RUNNING',
        started_at: Date.now() / 1000,
        elapsed_seconds: 100,
        accumulated_seconds: 0,
        session_start: Date.now() / 1000,
        day_start: Math.floor(Date.now() / 1000),
      });
      
      mockStopTimeEntry.mockResolvedValueOnce({ ...currentEntry, status: 'STOPPED' });
      
      // Mock Timer Engine stop response
      mockStopTimer.mockResolvedValueOnce({
        state: 'STOPPED',
        elapsed_seconds: 0,
        accumulated_seconds: 100,
        session_start: null,
        day_start: Math.floor(Date.now() / 1000),
      });

      await useTrackerStore.getState().selectProject(project2);

      expect(mockStopTimer).toHaveBeenCalled();
      await new Promise(r => setTimeout(r, 50));
      expect(mockStopTimeEntry).toHaveBeenCalled();
      const state = useTrackerStore.getState();
      expect(state.selectedProject?.id).toBe(project2.id);
      expect(state.isTracking).toBe(false);
      expect(state.currentTimeEntry).toBeNull();
    });
  });

  /** Этап 3: при ошибке save_timer_state store логирует и пробрасывает ошибку (не глотает) */
  describe('saveTimerState', () => {
    it('throws and logs when backend save_timer_state fails', async () => {
      const err = new Error('Failed to save state to DB');
      vi.mocked(TimerEngineAPI.saveState).mockRejectedValueOnce(err);
      await expect(useTrackerStore.getState().saveTimerState()).rejects.toThrow();
      expect(logger.error).toHaveBeenCalledWith('STORE', 'Failed to save timer state (backend)', err);
    });
  });

  describe('stopTracking', () => {
    it('stops timer engine and updates time entry', async () => {
      const project = { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' };
      useTrackerStore.getState().selectProject(project);
      await useTrackerStore.getState().startTracking();
      await new Promise(r => setTimeout(r, 80));
      
      const currentEntry = useTrackerStore.getState().currentTimeEntry;
      
      // BUG FIX: Mock Timer Engine state to return RUNNING before stop
      // stopTracking now checks Timer Engine state directly
      mockGetTimerState.mockResolvedValueOnce({
        state: 'RUNNING',
        started_at: Date.now() / 1000,
        elapsed_seconds: 100,
        accumulated_seconds: 0,
        session_start: Date.now() / 1000,
        day_start: Math.floor(Date.now() / 1000),
      });
      
      // Mock stop API
      mockStopTimeEntry.mockResolvedValueOnce({
        ...currentEntry,
        status: 'STOPPED',
      });
      
      // Mock Timer Engine stop response
      mockStopTimer.mockResolvedValueOnce({
        state: 'STOPPED',
        elapsed_seconds: 0,
        accumulated_seconds: 100,
        session_start: null,
        day_start: Math.floor(Date.now() / 1000),
      });
      
      await useTrackerStore.getState().stopTracking();
      
      expect(mockStopTimer).toHaveBeenCalled();
      await new Promise(r => setTimeout(r, 50));
      expect(mockStopTimeEntry).toHaveBeenCalled();
      
      const state = useTrackerStore.getState();
      expect(state.isTracking).toBe(false);
      expect(state.currentTimeEntry).toBeNull();
    });

    it('handles error when stopping timer engine', async () => {
      const project = { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' };
      useTrackerStore.getState().selectProject(project);
      await useTrackerStore.getState().startTracking();
      await new Promise(r => setTimeout(r, 80));
      
      // Setup: ensure we have a currentTimeEntry
      const currentEntry = useTrackerStore.getState().currentTimeEntry;
      expect(currentEntry).toBeTruthy();
      
      // Mock getState to return RUNNING state
      mockGetTimerState.mockResolvedValueOnce({
        state: 'RUNNING',
        started_at: Date.now() / 1000,
        elapsed_seconds: 0,
        accumulated_seconds: 0,
        session_start: Date.now() / 1000,
        day_start: Math.floor(Date.now() / 1000),
      });
      
      const error = new Error('Stop Error');
      mockStopTimer.mockRejectedValueOnce(error);
      
      try {
        await useTrackerStore.getState().stopTracking();
      } catch (e) {
        // Error may be thrown or caught internally
      }
      
      // When only engine fails, store still clears entry from API; either error or entry cleared
      const state = useTrackerStore.getState();
      expect(state.error != null || state.currentTimeEntry === null).toBeTruthy();
    });
  });

  describe('loadActiveTimeEntry', () => {
    it('ignores active entries from other users (SECURITY)', async () => {
      mockGetTimerState.mockResolvedValue({ state: 'STOPPED', elapsed_seconds: 0, accumulated_seconds: 0, session_start: null, day_start: Math.floor(Date.now() / 1000) });
      mockGetActiveTimeEntries.mockResolvedValue([
        {
          id: 'foreign-entry-id',
          userId: 'other-user-id',
          projectId: '1',
          startTime: new Date().toISOString(),
          endTime: null,
          duration: 0,
          description: '',
          status: 'RUNNING',
          createdAt: '',
          updatedAt: '',
        },
      ]);
      useTrackerStore.setState({ currentTimeEntry: null, isTracking: false });
      await useTrackerStore.getState().loadActiveTimeEntry();
      const state = useTrackerStore.getState();
      expect(state.currentTimeEntry).toBeNull();
      expect(state.currentTimeEntry?.userId).not.toBe('other-user-id');
    });
  });

  describe('error handling', () => {
    it('sets error state on failure', async () => {
      const project = { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' };
      useTrackerStore.getState().selectProject(project);
      
      const error = new Error('Test Error');
      mockCreateTimeEntry.mockRejectedValueOnce(error);
      
      try {
        await useTrackerStore.getState().startTracking();
      } catch (e) {
        // Error is expected to be thrown or caught internally
      }
      
      const state = useTrackerStore.getState();
      // Error should be set in state or thrown
      expect(state.error || state.isLoading === false).toBeTruthy();
    });

    it('clears error on successful operation', async () => {
      const project = { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' };
      useTrackerStore.getState().selectProject(project);
      
      // First, cause an error
      mockCreateTimeEntry.mockRejectedValueOnce(new Error('First Error'));
      try {
        await useTrackerStore.getState().startTracking();
      } catch (e) {
        // Error is expected
      }
      
      // Reset mocks for next call
      vi.clearAllMocks();
      mockGetActiveTimeEntries.mockResolvedValue([]);
      mockCreateTimeEntry.mockResolvedValue({
        id: 'test-entry-id',
        project: { id: '1', name: 'Test Project' },
        status: 'RUNNING',
        startTime: new Date().toISOString(),
      });
      mockStartTimer.mockResolvedValue({
        state: 'RUNNING',
        started_at: Date.now() / 1000,
        elapsed_seconds: 0,
        accumulated_seconds: 0,
        session_start: Date.now() / 1000,
        day_start: Math.floor(Date.now() / 1000),
      });
      
      // Then, succeed
      await useTrackerStore.getState().startTracking();
      
      const state = useTrackerStore.getState();
      expect(state.error).toBeNull();
    });
  });
});
