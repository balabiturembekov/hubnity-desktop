import { defineConfig, devices } from '@playwright/test';

/**
 * E2E тесты для Hubnity приложения
 * 
 * Примечание: Для Tauri приложения тесты запускаются через dev сервер
 * или через собранное приложение. Здесь используется подход с dev сервером.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  timeout: 60000, // Увеличиваем таймаут для тестов с длительными ожиданиями
  
  use: {
    baseURL: 'http://localhost:1420', // Tauri dev server default port
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 10000, // Таймаут для действий
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Запуск dev сервера перед тестами
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
