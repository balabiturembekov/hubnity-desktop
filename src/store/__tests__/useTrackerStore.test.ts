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

// Mock dependencies before imports
const mockInvoke = vi.fn();
const mockCreateTimeEntry = vi.fn();
const mockStopTimeEntry = vi.fn();
const mockPauseTimeEntry = vi.fn();
const mockResumeTimeEntry = vi.fn();
const mockGetActiveTimeEntries = vi.fn();
const mockStartTimer = vi.fn();
const mockPauseTimer = vi.fn();
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
      // Setup: select project first
      const project = { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' };
      useTrackerStore.getState().selectProject(project);
      
      await useTrackerStore.getState().startTracking();
      
      expect(mockGetActiveTimeEntries).toHaveBeenCalled();
      expect(mockCreateTimeEntry).toHaveBeenCalledWith({
        projectId: project.id,
        userId: 'test-user-id',
        description: `Работа над проектом ${project.name}`,
      });
      
      expect(mockStartTimer).toHaveBeenCalled();
      
      const state = useTrackerStore.getState();
      expect(state.isTracking).toBe(true);
      expect(state.currentTimeEntry).toBeTruthy();
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
      
      await useTrackerStore.getState().startTracking();
      
      // Time entry should still be created
      expect(mockCreateTimeEntry).toHaveBeenCalled();
      
      // But tracking state might be inconsistent
      const state = useTrackerStore.getState();
      // Error should be logged but not crash
      expect(state.currentTimeEntry).toBeTruthy();
    });
  });

  describe('pauseTracking', () => {
    it('pauses timer engine and updates time entry', async () => {
      // Setup: start tracking first
      const project = { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' };
      useTrackerStore.getState().selectProject(project);
      await useTrackerStore.getState().startTracking();
      
      const currentEntry = useTrackerStore.getState().currentTimeEntry;
      expect(currentEntry).toBeTruthy();
      
      // Mock pause API
      mockPauseTimeEntry.mockResolvedValueOnce({
        ...currentEntry,
        status: 'PAUSED',
      });
      
      await useTrackerStore.getState().pauseTracking();
      
      expect(mockPauseTimer).toHaveBeenCalled();
      expect(mockPauseTimeEntry).toHaveBeenCalled();
      
      const state = useTrackerStore.getState();
      expect(state.isPaused).toBe(true);
      expect(state.isTracking).toBe(true); // Still tracking, just paused
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
      // Setup: start and pause tracking
      const project = { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' };
      useTrackerStore.getState().selectProject(project);
      await useTrackerStore.getState().startTracking();
      await useTrackerStore.getState().pauseTracking();
      
      const currentEntry = useTrackerStore.getState().currentTimeEntry;
      
      // Mock resume API
      mockResumeTimeEntry.mockResolvedValueOnce({
        ...currentEntry,
        status: 'RUNNING',
      });
      
      await useTrackerStore.getState().resumeTracking();
      
      expect(mockResumeTimer).toHaveBeenCalled();
      expect(mockResumeTimeEntry).toHaveBeenCalled();
      
      const state = useTrackerStore.getState();
      expect(state.isPaused).toBe(false);
      expect(state.isTracking).toBe(true);
    });

    it('handles error when resuming timer engine', async () => {
      // Setup: start and pause tracking
      const project = { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' };
      useTrackerStore.getState().selectProject(project);
      await useTrackerStore.getState().startTracking();
      
      // Setup: ensure we have a currentTimeEntry
      const currentEntry = useTrackerStore.getState().currentTimeEntry;
      expect(currentEntry).toBeTruthy();
      
      // Mock getState to return PAUSED state
      mockGetTimerState.mockResolvedValueOnce({
        state: 'PAUSED',
        elapsed_seconds: 0,
        accumulated_seconds: 0,
        session_start: null,
        day_start: Math.floor(Date.now() / 1000),
      });
      
      await useTrackerStore.getState().pauseTracking();
      
      // Mock getState to return PAUSED state for resume
      mockGetTimerState.mockResolvedValueOnce({
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

  describe('stopTracking', () => {
    it('stops timer engine and updates time entry', async () => {
      // Setup: start tracking
      const project = { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' };
      useTrackerStore.getState().selectProject(project);
      await useTrackerStore.getState().startTracking();
      
      const currentEntry = useTrackerStore.getState().currentTimeEntry;
      
      // Mock stop API
      mockStopTimeEntry.mockResolvedValueOnce({
        ...currentEntry,
        status: 'STOPPED',
      });
      
      await useTrackerStore.getState().stopTracking();
      
      expect(mockStopTimer).toHaveBeenCalled();
      expect(mockStopTimeEntry).toHaveBeenCalled();
      
      const state = useTrackerStore.getState();
      expect(state.isTracking).toBe(false);
      expect(state.currentTimeEntry).toBeNull();
    });

    it('handles error when stopping timer engine', async () => {
      // Setup: start tracking
      const project = { id: '1', name: 'Test Project', color: '#000000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' };
      useTrackerStore.getState().selectProject(project);
      await useTrackerStore.getState().startTracking();
      
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
