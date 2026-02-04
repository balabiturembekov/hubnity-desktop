/**
 * Timer Engine Types - соответствуют Rust TimerEngine
 * Frontend НЕ считает время - только получает состояние из Rust
 */

/**
 * Состояние таймера - строгая FSM
 * Соответствует Rust TimerStateForAPI с #[serde(flatten)]
 * Из-за flatten, поля enum разворачиваются в TimerStateResponse
 */
export type TimerStateResponse = 
  | {
      state: 'STOPPED';
      elapsed_seconds: number;
      accumulated_seconds: number;
      session_start: null;
      day_start: number | null;
    }
  | {
      state: 'RUNNING';
      started_at: number;
      elapsed_seconds: number;
      accumulated_seconds: number;
      session_start: number;
      day_start: number | null;
    }
  | {
      state: 'PAUSED';
      elapsed_seconds: number;
      accumulated_seconds: number;
      session_start: null;
      day_start: number | null;
    };

/**
 * Timer Engine API - вызывает Rust команды
 * Frontend НЕ должен считать время самостоятельно
 */
export class TimerEngineAPI {
  /**
   * Начать трекинг (из состояния STOPPED)
   */
  static async start(): Promise<TimerStateResponse> {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<TimerStateResponse>('start_timer');
  }

  /**
   * Приостановить трекинг (из состояния RUNNING)
   */
  static async pause(): Promise<TimerStateResponse> {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<TimerStateResponse>('pause_timer');
  }

  /**
   * Возобновить трекинг (из состояния PAUSED)
   */
  static async resume(): Promise<TimerStateResponse> {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<TimerStateResponse>('resume_timer');
  }

  /**
   * Остановить трекинг (из состояния RUNNING или PAUSED)
   */
  static async stop(): Promise<TimerStateResponse> {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<TimerStateResponse>('stop_timer');
  }

  /**
   * Получить текущее состояние таймера
   * Frontend должен вызывать это периодически для обновления UI
   */
  static async getState(): Promise<TimerStateResponse> {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<TimerStateResponse>('get_timer_state');
  }

  /**
   * Сбросить накопленное время за день (при смене дня)
   */
  static async resetDay(): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('reset_timer_day');
  }

  /**
   * Сохранить состояние таймера в БД (например, при закрытии приложения)
   */
  static async saveState(): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('save_timer_state');
  }
}
