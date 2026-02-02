# STEP 4: Рефакторинг useCallSession (Оркестратор)

### Общая задача рефакторинга
Наша цель — упростить код видеозвонков так, чтобы он был понятен любому разработчику, даже без глубоких знаний TypeScript и WebRTC. Мы убираем сложные технические детали "под капот" и оставляем снаружи только простую и понятную логику (принцип KISS). Мы также убираем дублирование кода (принцип DRY).

---

### Что делаем в этом шаге
Мы собираем всё вместе в главном хуке `useCallSession`. Теперь он будет выглядеть как простой "сценарий" работы приложения, а не как набор разрозненных обработчиков событий.

### Зачем это нужно
Сейчас `useCallSession.ts` — это "Божественный объект" (God Object), который знает всё обо всём. Мы разгрузим его, делегировав задачи специализированным хукам (`useSignaling`, `useWebRTCManager`), которые мы сделали в шагах 2 и 3.

### Какие файлы меняем
- `frontend/src/hooks/useCallSession.ts`

### Пример кода

Код сократится в разы и станет линейным и понятным.

```typescript
// frontend/src/hooks/useCallSession.ts
import { useLocalMedia } from './useLocalMedia';
import { useSignaling } from './useSignaling';
import { useWebRTCManager } from './useWebRTCManager';
import { AppCallState } from '../services/types';

export function useCallSession(callId: string) {
  // 1. Получаем доступ к камере (самостоятельный хук)
  const { stream: localStream, error: mediaError } = useLocalMedia();

  // 2. Подключаемся к сигнальному серверу (самостоятельный хук)
  // Внутри он сам следит за сокетом
  const signaling = useSignaling(callId);

  // 3. Запускаем WebRTC магию (самостоятельный хук)
  // Мы просто передаем ему "трубку" (signaling) и "камеру" (localStream)
  const { remoteStream, connectionStatus, restart } = useWebRTCManager({
    localStream,
    signaling,
    isHost: signaling.role === 'host' // Роль теперь определяет сигналинг
  });

  // 4. Вычисляем общее состояние приложения для UI (см. Шаг 1)
  // Это чистая функция: берет состояния подсистем и выдает одно общее
  const appState: AppCallState = deriveAppState({
    mediaError,
    signalingReady: signaling.isReady,
    rtcStatus: connectionStatus
  });

  return {
    state: appState,         // Одно простое состояние
    localStream,             // Наше видео
    remoteStream,            // Видео собеседника
    hangup: () => { /* ... */ },
    retry: () => restart()   // Кнопка "переподключить"
  };
}

// Вспомогательная функция (можно вынести в отдельный файл)
function deriveAppState({ mediaError, signalingReady, rtcStatus }): AppCallState {
  if (mediaError) return 'FAILED';
  if (!signalingReady) return 'SIGNALING_CONNECT';
  if (rtcStatus === 'connected') return 'ACTIVE';
  if (rtcStatus === 'failed') return 'RECONNECTING';
  return 'WAITING_FOR_PEER';
}

---

### Подробные подшаги выполнения

#### 4.1. Очистка старого кода
- **Что сделать**: Удалить из `useCallSession.ts` все `useEffect`'ы, связанные с WebSocket, обработкой `onMessage`, таймерами реконнекта.
- **Зачем**: Этот код мы перенесли в специализированные хуки. Файл станет пустым каркасом.

#### 4.2. Подключение хуков-компонентов
- **Что сделать**: Последовательно вызвать:
    1. `useLocalMedia` -> получить `localStream`.
    2. `useSignaling(callId)` -> получить `signaling` объект.
    3. `useWebRTCManager({ signaling, localStream, ... })` -> получить `remoteStream` и статус.

#### 4.3. Функция вычисления состояния (Derive State)
- **Что сделать**: Написать функцию `deriveAppState`, которая принимает флаги от всех трех хуков.
- **Как**:
    - Если `media.error` -> `FAILED`.
    - Если `!signaling.isReady` -> `SIGNALING_CONNECT`.
    - Если `webRTC.status === 'connected'` -> `ACTIVE`.
    - И так далее.
- **Зачем**: Это единственный источник правды для UI.

#### 4.4. Сборка возвращаемого объекта
- **Что сделать**: Вернуть объект, соответствующий новому интерфейсу, который мы придумали для UI.
- **Результат**: Файл `useCallSession.ts` станет коротким (строк 50-60) и очень легко читаемым.
```
