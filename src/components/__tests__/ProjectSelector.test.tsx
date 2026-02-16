/**
 * Unit тесты для ProjectSelector
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ProjectSelector } from '../ProjectSelector';

const mockLoadProjects = vi.fn();
const mockSelectProject = vi.fn();

const defaultState = {
  projects: [
    { id: '1', name: 'Project A', color: '#ff0000', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' },
    { id: '2', name: 'Project B', color: '#00ff00', description: '', clientName: '', budget: 0, status: 'ACTIVE' as const, companyId: '', createdAt: '', updatedAt: '' },
  ],
  selectedProject: null as { id: string; name: string; color: string } | null,
  loadProjects: mockLoadProjects,
  selectProject: mockSelectProject,
  isLoading: false,
  error: null as string | null,
};

vi.mock('../../store/useTrackerStore', () => ({
  useTrackerStore: (selector: (s: typeof defaultState) => unknown) => {
    return selector ? selector(defaultState) : defaultState;
  },
}));

let mockIsOnline = true;
vi.mock('../../store/useSyncStore', () => ({
  useSyncStore: (selector: (s: { status: { is_online: boolean } | null }) => unknown) => {
    return selector({ status: { is_online: mockIsOnline } });
  },
}));

describe('ProjectSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOnline = true;
    mockLoadProjects.mockResolvedValue(undefined);
    mockSelectProject.mockResolvedValue(undefined);
    defaultState.isLoading = false;
    defaultState.error = null;
    defaultState.projects = [
      { id: '1', name: 'Project A', color: '#ff0000', description: '', clientName: '', budget: 0, status: 'ACTIVE', companyId: '', createdAt: '', updatedAt: '' },
      { id: '2', name: 'Project B', color: '#00ff00', description: '', clientName: '', budget: 0, status: 'ACTIVE', companyId: '', createdAt: '', updatedAt: '' },
    ];
    defaultState.selectedProject = null;
  });

  it('calls loadProjects on mount', async () => {
    render(<ProjectSelector />);
    await waitFor(() => {
      expect(mockLoadProjects).toHaveBeenCalled();
    });
  });

  it('shows Project label', () => {
    render(<ProjectSelector />);
    expect(screen.getByText(/Project:/i)).toBeInTheDocument();
  });

  it('shows Loading when isLoading', () => {
    defaultState.isLoading = true;
    defaultState.projects = [];
    render(<ProjectSelector />);
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
  });

  it('shows error and Retry when error (online)', () => {
    defaultState.error = 'Network error';
    defaultState.projects = [];
    mockIsOnline = true;
    render(<ProjectSelector />);
    expect(screen.getByText('Network error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('shows Offline message and Retry when error (offline)', () => {
    defaultState.error = 'Network Error';
    defaultState.projects = [];
    mockIsOnline = false;
    render(<ProjectSelector />);
    expect(screen.getByText(/Offline — projects unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('shows No projects when projects empty', () => {
    defaultState.projects = [];
    render(<ProjectSelector />);
    expect(screen.getByText(/No projects/i)).toBeInTheDocument();
  });
});
