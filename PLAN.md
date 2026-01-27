## План: Добавление переподключения в видеозвонки

Цель — обеспечить устойчивость звонка при потере WebSocket или WebRTC соединения. При разрыве соединения клиенты переходят в состояние «переподключение» и автоматически пытаются восстановить связь в течение 30 минут. Сервер не завершает звонок при отключении участника.

---

### Шаг 1: Добавить автоматическое переподключение WebSocket на фронтенде

**Цель**: При закрытии WebSocket соединения пытаться переподключиться с exponential backoff вместо завершения звонка.

**Изменения**:
- В [frontend/src/services/signaling.ts](frontend/src/services/signaling.ts#L161-L167) переработать `socket.onclose`:
  - Не удалять соединение из `sharedConnections` при ненормальном закрытии
  - Добавить функцию `scheduleReconnect` с exponential backoff (1s, 2s, 4s, 8s, 10s)
  - Вызывать новый колбэк `onReconnecting` для уведомления UI
- Добавить в `SignalingListener` новые методы: `onReconnecting`, `onReconnected`, `onReconnectFailed`
- Расширить `SharedConnection` полями `reconnectAttempts`, `reconnectTimer`, `callEnded`

---

### Шаг 2: Обновить модель состояния звонка на бэкенде

**Цель**: Отслеживать время отключения участников и не завершать звонок при потере соединения.

**Изменения**:
- В [internal/models/call_v2.go](internal/models/call_v2.go) расширить `CallParticipantV2`:
  - Добавить `DisconnectedAt time.Time` для отслеживания момента отключения
  - Добавить `ReconnectCount int` для статистики
- В [internal/handlers/store.go](internal/handlers/store.go) добавить метод `MarkPeerDisconnected(callID, peerID string, now time.Time)` — устанавливает `IsPresent = false` и `DisconnectedAt`
- В [internal/handlers/ws.go](internal/handlers/ws.go#L105-L113) в `readPump` defer вызывать `MarkPeerDisconnected` вместо простого `Remove`

---

### Шаг 3: Добавить WebSocket сообщения для переподключения

**Цель**: Уведомлять участников о переподключении peer-а и отправлять статус peer-а при подключении.

**Изменения**:
- В [internal/handlers/ws.go](internal/handlers/ws.go#L83-L91) расширить `wsJoinDataV2`:
  - Добавить `IsReconnect bool` — флаг, что это переподключение
  - Добавить `PeerOnline bool` — текущий статус другого участника
- Добавить новые типы сообщений:
  - `peer-disconnected` — отправляется при отключении peer-а
  - `peer-reconnected` — отправляется при переподключении peer-а
- В `readPump` defer отправлять `peer-disconnected` вместо `leave`

---

### Шаг 4: Добавить ICE Restart на фронтенде

**Цель**: При потере WebRTC соединения (`disconnected`/`failed`) выполнять ICE restart вместо завершения звонка.

**Изменения**:
- В [frontend/src/hooks/useCallSession.ts](frontend/src/hooks/useCallSession.ts#L395-L420) переработать `oniceconnectionstatechange`:
  - При `disconnected` — выждать 3 секунды, затем ICE restart
  - При `failed` — немедленный ICE restart
- Добавить функцию `performIceRestart`:
  - Создать offer с `{ iceRestart: true }`
  - Отправить через сигнализацию
- В [frontend/src/hooks/useCallSession.ts](frontend/src/hooks/useCallSession.ts#L439-L445) переработать обработчик `onLeave`:
  - Не вызывать `teardownSession()` сразу
  - Установить состояние `peer-disconnected` и запустить таймер ожидания (30 секунд)

---

### Шаг 5: Добавить состояние переподключения и UI индикацию

**Цель**: Отобразить пользователю состояние переподключения в интерфейсе.

**Изменения**:
- В [frontend/src/services/types.ts](frontend/src/services/types.ts) добавить тип `ReconnectionState`:
  ```typescript
  type ReconnectionState = 'connected' | 'reconnecting' | 'peer-disconnected' | 'failed';
  ```
- В [frontend/src/hooks/useCallSession.ts](frontend/src/hooks/useCallSession.ts) добавить:
  - `reconnectionState` — состояние переподключения
  - `peerDisconnected` — флаг отключения peer-а
  - Таймер ожидания переподключения peer-а
- В [frontend/src/pages/CallPage.tsx](frontend/src/pages/CallPage.tsx) добавить UI компоненты:
  - Оверлей «Переподключение...» при `reconnectionState === 'reconnecting'`
  - Индикатор «Собеседник отключился, ожидание...» при `peerDisconnected`

---

### Шаг 6: Обработать переподключение peer-а и восстановление WebRTC

**Цель**: После переподключения peer-а автоматически восстановить WebRTC соединение.

**Изменения**:
- В [frontend/src/hooks/useCallSession.ts](frontend/src/hooks/useCallSession.ts) добавить обработчики:
  - `onPeerReconnected` — сбросить `peerDisconnected`, инициировать переустановку WebRTC
  - При получении `join` с `IsReconnect: true` — выполнить renegotiation
- Добавить логику повторного обмена TURN credentials при переподключении:
  - В [frontend/src/hooks/useCallSession.ts](frontend/src/hooks/useCallSession.ts#L180-L200) — повторный вызов API для TURN config
  - Создать новый `RTCPeerConnection` с обновлёнными ICE серверами

---

### Шаг 7: Добавить 30-минутный таймаут на бэкенде

**Цель**: Сервер ожидает переподключение 30 минут с момента последнего успешного обмена.

**Изменения**:
- В [internal/handlers/store.go](internal/handlers/store.go) модифицировать логику `ExpiresAt`:
  - При отключении участника — не менять `ExpiresAt`
  - Добавить константу `ReconnectTimeout = 30 * time.Minute`
  - Звонок завершается когда `DisconnectedAt + 30min < now` для обоих участников
- Убедиться, что `cleanupExpiredCalls` корректно обрабатывает отключённые звонки


