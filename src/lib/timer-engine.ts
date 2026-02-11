/**
 * Timer Engine Types - соответствуют Rust TimerEngine
 * Frontend НЕ считает время - только получает состояние из Rust
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * Состояние таймера - строгая FSM
 * Соответствует Rust TimerStateForAPI с #[serde(flatten)]
 * Из-за flatten, поля enum разворачиваются в TimerStateResponse
 */
export type TimerStateResponse = (
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
    }
) & {
  /** Секунды за текущий календарный день (для "Today" display). После rollover — только время с полуночи */
  today_seconds?: number;
  /** Этап 4: true если таймер восстановлен из RUNNING как PAUSED после перезапуска (показать уведомление один раз) */
  restored_from_running?: boolean;
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
    return await invoke<TimerStateResponse>('start_timer');
  }

  /**
   * Приостановить трекинг (из состояния RUNNING)
   */
  static async pause(): Promise<TimerStateResponse> {
    return await invoke<TimerStateResponse>('pause_timer');
  }

  /**
   * Возобновить трекинг (из состояния PAUSED)
   */
  static async resume(): Promise<TimerStateResponse> {
    return await invoke<TimerStateResponse>('resume_timer');
  }

  /**
   * Остановить трекинг (из состояния RUNNING или PAUSED)
   */
  static async stop(): Promise<TimerStateResponse> {
    return await invoke<TimerStateResponse>('stop_timer');
  }

  /**
   * Получить текущее состояние таймера
   * Frontend должен вызывать это периодически для обновления UI
   */
  static async getState(): Promise<TimerStateResponse> {
    return await invoke<TimerStateResponse>('get_timer_state');
  }

  /**
   * Сбросить накопленное время за день (при смене дня)
   */
  static async resetDay(): Promise<void> {
    await invoke('reset_timer_day');
  }

  /**
   * Сохранить состояние таймера в БД (например, при закрытии приложения)
   */
  static async saveState(): Promise<void> {
    await invoke('save_timer_state');
  }
}
