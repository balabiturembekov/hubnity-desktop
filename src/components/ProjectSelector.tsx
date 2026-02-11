import { useEffect } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { useTrackerStore } from '../store/useTrackerStore';
import { logger } from '../lib/logger';

/**
 * PRODUCTION: Упрощенный ProjectSelector
 * - Inline формат без Card обертки
 * - Минимальный визуальный вес
 * - Компактное отображение
 */
export function ProjectSelector() {
  const { projects, selectedProject, loadProjects, selectProject, isLoading, error } = useTrackerStore();

  useEffect(() => {
    loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelect = (projectId: string) => {
    const project = projects.find((p) => p.id === projectId);
    if (project) {
      selectProject(project).catch((error) => {
        // BUG FIX: Log error instead of silently ignoring
        // Ошибка уже в store (error), UI покажет, но логируем для отладки
        logger.debug('PROJECT_SELECTOR', 'Failed to select project (error shown in UI)', error);
      });
    } else {
      // BUG FIX: Log warning if project not found
      logger.warn('PROJECT_SELECTOR', `Project with id ${projectId} not found in projects list`);
    }
  };

  // Inline формат без Card обертки - macOS-style
  return (
    <div className="flex items-center gap-2.5 px-1 py-1.5">
      <span className="text-xs text-muted-foreground/70 whitespace-nowrap">Project:</span>
      {isLoading ? (
        <span className="text-sm text-muted-foreground">Loading...</span>
      ) : error ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-destructive">{error}</span>
          <button
            onClick={() => loadProjects()}
            className="text-xs text-primary underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      ) : projects.length === 0 ? (
        <span className="text-sm text-muted-foreground">No projects</span>
      ) : (
        <Select
          value={selectedProject?.id || ''}
          onValueChange={handleSelect}
        >
          <SelectTrigger className="h-auto w-auto min-w-[180px] border-none shadow-none bg-transparent hover:bg-muted/30 hover:underline px-1.5 py-0.5 -ml-1 rounded transition-colors duration-300">
            <SelectValue placeholder="Select project">
              {selectedProject && (
                <div className="flex items-center gap-2 group">
                  <div
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: selectedProject.color }}
                  />
                  <span className="text-sm text-foreground group-hover:text-foreground/90 transition-colors">
                    {selectedProject.name}
                  </span>
                </div>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                <div className="flex items-center gap-2">
                  <div
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: project.color }}
                  />
                  <span className="truncate text-foreground">{project.name}</span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
