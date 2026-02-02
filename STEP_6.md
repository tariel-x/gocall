# STEP 6: Обновление компонентов UI (Update Consumers)

### Общая задача рефакторинга
Наша цель — упростить код видеозвонков. Теперь, когда у нас есть простой и понятный хук `useCallSession`, нам нужно обновить визуальную часть приложения (`CallPage` и другие компоненты), чтобы они использовали этот новый удобный интерфейс.

---

### Что делаем в этом шаге
Мы заменяем старую сложную логику отображения в компонентах `CallPage.tsx` и `CallStatusPanel.tsx` на новую, основанную на едином состоянии `AppCallState`.

### Зачем это нужно
Старый код UI компонентов был вынужден сам разбираться в деталях: "Если `wsState` такой-то, а `participants` > 1, то покажи это". Теперь UI компоненты станут "глупыми" (в хорошем смысле) — они будут просто отображать то, что им сказал хук.

### Какие файлы меняем
- `frontend/src/pages/CallPage.tsx`
- `frontend/src/components/CallStatusPanel.tsx` (и, возможно, `CallControls.tsx`)

### Пример кода

#### CallPage.tsx

```tsx
// frontend/src/pages/CallPage.tsx
import React from 'react';
import { useParams } from 'react-router-dom';
import { useCallSession } from '../hooks/useCallSession';
import { CallStatusPanel } from '../components/CallStatusPanel';
import { VideoPlayer } from '../components/VideoPlayer'; // Предположим, у нас есть такой компонент

export const CallPage: React.FC = () => {
  const { callId } = useParams<{ callId: string }>();
  
  // Используем наш новый супер-простой хук
  const { 
    state,           // AppCallState ('ACTIVE', 'WAITING'...)
    localStream, 
    remoteStream, 
    hangup, 
    retry 
  } = useCallSession(callId);

  return (
    <div className="call-page">
      {/* Панель статуса теперь принимает только state и ошибку */}
      <CallStatusPanel state={state} onRetry={retry} />

      <div className="video-grid">
        {/* Показываем локальное видео всегда (или почти всегда) */}
        {localStream && (
          <VideoPlayer stream={localStream} muted={true} label="Вы" />
        )}

        {/* Показываем удаленное видео только если звонок активен */}
        {state === 'ACTIVE' && remoteStream && (
          <VideoPlayer stream={remoteStream} label="Собеседник" />
        )}
      </div>

      <CallControls onHangup={hangup} />
    </div>
  );
};
```

#### CallStatusPanel.tsx

```tsx
// frontend/src/components/CallStatusPanel.tsx
import React from 'react';
import { AppCallState } from '../services/types';
import { getCallStatusMessage } from '../utils/callStatusUtils'; // Наша утилита из шага 5

interface Props {
  state: AppCallState;
  onRetry: () => void;
}

export const CallStatusPanel: React.FC<Props> = ({ state, onRetry }) => {
  // Если звонок идет нормально, панель не нужна (или она прозрачная)
  if (state === 'ACTIVE') return null;

  const message = getCallStatusMessage(state);
  const isError = state === 'FAILED' || state === 'RECONNECTING';

  return (
    <div className={`status-panel ${isError ? 'error' : ''}`}>
      <p>{message}</p>
      
      {/* Показываем кнопку "Повторить" только при проблемах */}
      {isError && (
        <button onClick={onRetry}>Попробовать снова</button>
      )}
    </div>
  );
};
```

### Почему это упрощает жизнь
Код компонента страницы уменьшился в два раза. Логика отображения ("показывать кнопку или нет") теперь очевидна. Верстальщику проще работать с макетом, так как не нужно думать о WebRTC состояниях.

---

### Подробные подшаги выполнения

#### 6.1. Обновление CallStatusPanel
- **Что сделать**: Открыть `frontend/src/components/CallStatusPanel.tsx`.
- **Как**:
    - Заменить старые пропсы на `{ state: AppCallState, onRetry: () => void }`.
    - Использовать `getCallStatusMessage(state)` для получения текста.
    - Убрать всю сложную логику `if` внутри JSX.

#### 6.2. Обновление CallPage
- **Что сделать**: Открыть `frontend/src/pages/CallPage.tsx`.
- **Как**:
    - Обновить вызов `useCallSession`. Деструктурировать новые поля: `state`, `retry`.
    - Удалить использование старых полей (`wsState`, `iceConnectionState`).
    - Передать `state` в обновленный `CallStatusPanel`.
    - Использовать `state === 'ACTIVE'` как условие для отображения видео собеседника.

#### 6.3. Проверка типов
- **Что сделать**: Запустить TypeScript проверку (или посмотреть в редакторе), чтобы убедиться, что нигде не остались старые обращения к удаленным полям.
- **Результат**: Приложение собирается без ошибок, UI код стал чище.
