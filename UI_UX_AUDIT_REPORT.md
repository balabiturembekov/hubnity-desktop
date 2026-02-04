# 🎨 UI/UX AUDIT REPORT

## Hubnity Time Tracker — macOS Desktop App

**Дата:** 12 января 2026  
**Аудитор:** Senior Product Designer + Frontend Engineer  
**Цель:** Calm, Focus-first, macOS-native UI для долгой ежедневной работы

---

## 📊 EXECUTIVE SUMMARY

**Текущее состояние:** 75/100  
**Целевое состояние:** 95/100

**Ключевые находки:**

- ✅ Таймер уже является визуальным центром
- ⚠️ Цветовая система требует калибровки для macOS
- ⚠️ Density слишком "web-like" в некоторых зонах
- ⚠️ Кнопка Stop создает излишний визуальный стресс
- ✅ Навигация близка к macOS-native
- ⚠️ Скриншоты могут вызывать тревожность (surveillance feeling)

**Критичность:** P0 — 3 проблемы, P1 — 5 проблем, P2 — 4 проблемы

---

## 🔍 ПРОБЛЕМЫ → РЕШЕНИЯ → ПОЧЕМУ

### P0 — КРИТИЧЕСКИЕ (влияют на ежедневный комфорт)

| Проблема                                                        | Решение                                                                   | Почему                                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Green слишком яркий** (`text-green-600`) для долгой работы    | Использовать `text-green-500` или кастомный `hsl(142 71% 45%)`            | macOS использует более приглушенный green. Яркий green-600 утомляет глаза при 8+ часах работы |
| **Stop кнопка слишком агрессивная** (`bg-destructive/90`)       | Использовать `bg-red-500/80` или `hsl(0 72% 50%)` с `hover:bg-red-500/90` | Panic-red эффект мешает фокусу. Нужен "soft destructive"                                      |
| **Idle time желтый** (`text-yellow-600`) конкурирует с таймером | Использовать `text-muted-foreground` или `text-amber-500/70`              | Желтый слишком заметен, отвлекает от основного таймера                                        |

### P1 — ВЫСОКИЕ (влияют на восприятие как desktop app)

| Проблема                                                             | Решение                                                             | Почему                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Spacing неконсистентный** (py-8, py-1.5, px-6 смешаны)             | Ввести spacing tokens: `space-timer: 3rem`, `space-section: 1.5rem` | Desktop apps требуют более плотной, но предсказуемой структуры         |
| **Timer status indicator слишком заметный** (`animate-pulse` всегда) | Пульсация только при RUNNING, при PAUSED — статичный dot            | Постоянная анимация отвлекает, особенно при паузе                      |
| **Screenshots section может вызывать тревожность**                   | Добавить subtle hint: "Автоматически каждые 1-10 минут"             | Пользователи могут чувствовать surveillance, нужно объяснить поведение |
| **Project selector hover слишком subtle**                            | Добавить `hover:bg-muted/30` для лучшей feedback                    | macOS требует четкий hover feedback для интерактивных элементов        |
| **Footer sync indicator слишком маленький** (`text-[10px]`)          | Использовать `text-xs` (12px) для читаемости                        | 10px слишком мал даже для secondary информации                         |

### P2 — СРЕДНИЕ (улучшают polish)

| Проблема                              | Решение                                                                       | Почему                                               |
| ------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Border-radius неконсистентный**     | Унифицировать: `rounded-md` (6px) для кнопок, `rounded` (4px) для индикаторов | macOS использует консистентные радиусы               |
| **Font sizes не следуют scale**       | Использовать: `text-6xl` (timer), `text-sm` (UI), `text-xs` (meta)            | Четкая типографическая иерархия улучшает scanability |
| **Shadow отсутствует где нужно**      | Добавить `shadow-sm` только для dropdowns/popovers                            | macOS использует subtle shadows для elevation        |
| **Color transitions слишком быстрые** | Увеличить до `duration-300` для плавности                                     | 200ms может ощущаться резко, 300ms более естественно |

---

## 🎯 ПРИОРИТИЗИРОВАННЫЙ ЧЕКЛИСТ

### P0 — КРИТИЧЕСКИЕ (сделать немедленно)

- [ ] **P0.1** Заменить `text-green-600` на macOS-friendly green
- [ ] **P0.2** Смягчить Stop кнопку (убрать panic-red)
- [ ] **P0.3** Изменить idle time color на muted

### P1 — ВЫСОКИЕ (сделать в этом спринте)

- [ ] **P1.1** Ввести spacing tokens в tailwind.config
- [ ] **P1.2** Убрать постоянную пульсацию status indicator
- [ ] **P1.3** Добавить hint для screenshots section
- [ ] **P1.4** Улучшить hover feedback в ProjectSelector
- [ ] **P1.5** Увеличить footer sync indicator до `text-xs`

### P2 — СРЕДНИЕ (сделать при возможности)

- [ ] **P2.1** Унифицировать border-radius
- [ ] **P2.2** Проверить font scale консистентность
- [ ] **P2.3** Добавить subtle shadows для elevation
- [ ] **P2.4** Увеличить transition duration до 300ms

---

## 🎨 ДИЗАЙН-СИСТЕМА ЧЕРЕЗ КОД

### 1. SPACING TOKENS

```javascript
// tailwind.config.js
theme: {
  extend: {
    spacing: {
      'timer': '3rem',      // 48px - пространство вокруг таймера
      'section': '1.5rem',  // 24px - между секциями
      'element': '0.75rem', // 12px - между элементами
      'tight': '0.5rem',    // 8px - плотное spacing
    }
  }
}
```

**Использование:**

- `py-timer` для вертикального spacing вокруг таймера
- `mb-section` для spacing между секциями
- `gap-element` для spacing между элементами

### 2. FONT SIZES

```javascript
// Уже используется правильно, но нужно зафиксировать:
text-6xl  // Timer (72px) - главный элемент
text-2xl  // Idle time (24px) - вторичный
text-sm   // UI элементы (14px) - стандарт
text-xs   // Meta информация (12px) - минимальный
text-[10px] // УДАЛИТЬ - использовать text-xs
```

### 3. BORDER-RADIUS

```javascript
// tailwind.config.js
borderRadius: {
  'ui': '6px',    // Кнопки, inputs
  'indicator': '4px', // Status indicators
  'card': '8px',  // Cards (если появятся)
  'full': '9999px', // Dots, badges
}
```

**Использование:**

- `rounded-ui` для кнопок
- `rounded-indicator` для status dots
- `rounded-full` для цветных точек проектов

### 4. SHADOW RULES

```javascript
// Только для elevation, не для декорации
shadow - sm; // Dropdowns, popovers
shadow - none; // Кнопки, индикаторы (macOS не использует shadows на кнопках)
```

### 5. COLOR SYSTEM

#### macOS-Friendly Green (для RUNNING состояния)

```css
/* src/index.css */
:root {
  --timer-running: 142 71% 45%; /* macOS System Green */
  --timer-running-dark: 142 65% 50%;
}

.dark {
  --timer-running: 142 65% 50%;
  --timer-running-dark: 142 71% 45%;
}
```

```javascript
// tailwind.config.js
colors: {
  timer: {
    running: 'hsl(var(--timer-running))',
    runningDark: 'hsl(var(--timer-running-dark))',
  }
}
```

**Использование:**

- `text-timer-running` вместо `text-green-600`
- Более спокойный, не утомляет глаза

#### Soft Destructive (для Stop кнопки)

```css
/* src/index.css */
:root {
  --destructive-soft: 0 72% 50%; /* Менее агрессивный red */
  --destructive-soft-hover: 0 72% 55%;
}

.dark {
  --destructive-soft: 0 65% 45%;
  --destructive-soft-hover: 0 65% 50%;
}
```

```javascript
// tailwind.config.js
colors: {
  destructive: {
    soft: 'hsl(var(--destructive-soft))',
    softHover: 'hsl(var(--destructive-soft-hover))',
  }
}
```

**Использование:**

- `bg-destructive-soft` вместо `bg-destructive/90`
- Меньше визуального стресса

#### Muted Colors (для PAUSED/STOPPED)

```css
/* Уже есть в системе, но нужно использовать консистентно */
--muted-foreground: 215.4 16.3% 46.9%; /* Для paused/stopped */
```

**Использование:**

- `text-muted-foreground` для PAUSED состояния
- `text-muted-foreground/80` для STOPPED состояния

---

## 🎯 КОНКРЕТНЫЕ РЕКОМЕНДАЦИИ

### 1. ТАЙМЕР — ВИЗУАЛЬНАЯ ДОМИНАНТА

**Текущее состояние:** ✅ Хорошо (text-6xl, центрирован)

**Улучшения:**

```tsx
// src/components/Timer.tsx

// P0.1: macOS-friendly green
<div
  className={cn(
    "text-6xl font-mono font-bold tracking-tight transition-colors duration-300",
    timerStateInfo.state === "RUNNING"
      ? "text-timer-running dark:text-timer-running-dark"
      : timerStateInfo.color
  )}
>
  {formatTime(elapsedSeconds)}
</div>;

// P0.3: Idle time muted
{
  timerState?.state === "PAUSED" && idlePauseStartTime && (
    <div className="flex flex-col items-center space-y-1">
      <div className="text-xs text-muted-foreground font-medium">Простой:</div>
      <div className="text-2xl font-mono text-muted-foreground/80">
        {formatTime(idleTime)}
      </div>
    </div>
  );
}

// P1.2: Пульсация только при RUNNING
{
  timerState && timerState.state === "RUNNING" && (
    <div className={cn("w-2 h-2 rounded-full bg-green-500", "animate-pulse")} />
  );
}
{
  timerState && timerState.state === "PAUSED" && (
    <div className="w-2 h-2 rounded-full bg-muted-foreground/40" />
  );
}
```

**Почему:**

- macOS System Green (142 71% 45%) — стандарт для активных состояний
- Muted idle time не конкурирует с основным таймером
- Пульсация только при активности снижает cognitive load

### 2. КНОПКИ PAUSE / STOP

**Текущее состояние:** ⚠️ Stop слишком агрессивная

**Улучшения:**

```tsx
// src/components/Timer.tsx

// P0.2: Soft destructive для Stop
<Button
  onClick={handleStop}
  disabled={isLoading || isProcessing}
  size="lg"
  className="gap-2 px-6 h-10 text-sm rounded-md bg-destructive-soft hover:bg-destructive-soft-hover text-white"
>
  <Square className="h-4 w-4" />
  Стоп
</Button>

// Pause остается default (neutral primary)
<Button
  onClick={handlePause}
  disabled={isLoading || isProcessing}
  size="lg"
  variant="default"
  className="gap-2 px-6 h-10 text-sm rounded-md"
>
  <Pause className="h-4 w-4" />
  Пауза
</Button>
```

**Почему:**

- Soft red (0 72% 50%) менее агрессивен, но все еще сигнализирует о destructive action
- Сохраняет accessibility (достаточный контраст)
- Не создает panic-red эффект

### 3. НАВИГАЦИЯ (Tracker / Settings)

**Текущее состояние:** ✅ Уже близко к macOS-native

**Минимальные улучшения:**

```tsx
// src/components/ui/tabs.tsx

// Уже хорошо, но можно улучшить border
const TabsList = React.forwardRef<...>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex h-8 items-center justify-center rounded border border-border/60 bg-transparent p-0.5 gap-0.5",
      className
    )}
    {...props}
  />
))

// Active state уже хорош
const TabsTrigger = React.forwardRef<...>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex items-center justify-center whitespace-nowrap rounded px-3 py-1 text-sm font-medium text-muted-foreground transition-colors duration-200 data-[state=active]:bg-muted/80 data-[state=active]:text-foreground",
      className
    )}
    {...props}
  />
))
```

**Почему:**

- `border-border/60` делает border менее заметным
- `bg-muted/80` вместо `bg-muted` для более subtle active state
- Уже соответствует macOS segmented control pattern

### 4. СКРИНШОТЫ — УБРАТЬ ТРЕВОЖНОСТЬ

**Текущее состояние:** ⚠️ Может вызывать surveillance feeling

**Улучшения:**

```tsx
// src/components/ScreenshotsView.tsx

// P1.3: Добавить hint для объяснения поведения
<button
  onClick={() => setIsExpanded(!isExpanded)}
  className="w-full flex items-center justify-between px-1 py-1.5 hover:bg-transparent transition-colors group"
>
  <div className="flex items-center gap-2">
    <Camera className="h-3.5 w-3.5 text-muted-foreground/60" />
    <span className="text-xs text-muted-foreground/70 group-hover:text-muted-foreground transition-colors">
      Скриншоты
    </span>
    {screenshots.length > 0 && (
      <span className="text-[10px] text-muted-foreground/50">
        {screenshots.length}
      </span>
    )}
    {/* P1.3: Subtle hint */}
    <span className="text-[10px] text-muted-foreground/40 italic ml-1">
      (автоматически)
    </span>
  </div>
  {isExpanded ? (
    <ChevronUp className="h-3 w-3 text-muted-foreground/50" />
  ) : (
    <ChevronDown className="h-3 w-3 text-muted-foreground/50" />
  )}
</button>
```

**Почему:**

- "(автоматически)" объясняет, что скриншоты делаются системой, а не пользователем вручную
- Снижает тревожность от surveillance feeling
- Малозаметный, не перегружает UI

### 5. PROJECT SELECTOR — УЛУЧШИТЬ FEEDBACK

**Текущее состояние:** ⚠️ Hover слишком subtle

**Улучшения:**

```tsx
// src/components/ProjectSelector.tsx

// P1.4: Улучшить hover feedback
<SelectTrigger className="h-auto w-auto min-w-[180px] border-none shadow-none bg-transparent hover:bg-muted/30 hover:underline px-1.5 py-0.5 -ml-1 rounded transition-colors duration-200">
  <SelectValue placeholder="Выберите проект">
    {selectedProject && (
      <div className="flex items-center gap-2 group">
        <div
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: selectedProject.color }}
        />
        <span className="text-sm text-foreground group-hover:text-foreground transition-colors">
          {selectedProject.name}
        </span>
      </div>
    )}
  </SelectValue>
</SelectTrigger>
```

**Почему:**

- `hover:bg-muted/30` дает четкий визуальный feedback
- `rounded` для плавного hover эффекта
- Соответствует macOS hover patterns

### 6. FOOTER SYNC INDICATOR

**Текущее состояние:** ⚠️ Слишком маленький текст

**Улучшения:**

```tsx
// src/components/SyncIndicator.tsx

// P1.5: Увеличить до text-xs для читаемости
<span className="text-xs text-muted-foreground/50">
  {syncState === "synced"
    ? "Синхронизировано"
    : syncState === "syncing"
    ? `${status.pending_count}`
    : "Офлайн"}
</span>
```

**Почему:**

- `text-xs` (12px) — минимальный читаемый размер для desktop
- `text-[10px]` слишком мал даже для secondary информации

---

## 🚨 ФУНДАМЕНТАЛЬНЫЕ UX-ОШИБКИ

### ❌ КРИТИЧЕСКАЯ: Idle Time Yellow конкурирует с Timer

**Проблема:** Желтый цвет idle time (`text-yellow-600`) слишком заметен и отвлекает от основного таймера.

**Решение:** Использовать `text-muted-foreground/80` для idle time.

**Почему критично:** При паузе из-за idle пользователь должен видеть основной таймер, а не желтый idle counter. Желтый создает визуальный конфликт.

---

## 📋 ИТОГОВЫЙ ПЛАН ДЕЙСТВИЙ

### Этап 1: P0 (Критические) — 30 минут

1. Заменить green на macOS-friendly
2. Смягчить Stop кнопку
3. Изменить idle time color

### Этап 2: P1 (Высокие) — 1 час

1. Ввести spacing tokens
2. Убрать постоянную пульсацию
3. Добавить hint для screenshots
4. Улучшить hover feedback
5. Увеличить footer text

### Этап 3: P2 (Средние) — 30 минут

1. Унифицировать border-radius
2. Проверить font scale
3. Добавить shadows где нужно
4. Увеличить transitions

---

## ✅ КРИТЕРИИ УСПЕХА

После внедрения всех P0 и P1:

- ✅ Таймер доминирует визуально без конкуренции
- ✅ Цвета не утомляют при 8+ часах работы
- ✅ Stop кнопка не создает panic-red эффект
- ✅ UI ощущается как macOS-native, не web
- ✅ Cognitive load минимален
- ✅ Скриншоты не вызывают тревожность

---

**Следующий шаг:** Начать с P0.1 (macOS-friendly green) — самое критичное изменение.
