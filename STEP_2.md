# STEP 2: Рефакторинг useSignaling (Умный Сигналинг)

### Общая задача рефакторинга
Наша цель — упростить код видеозвонков так, чтобы он был понятен любому разработчику, даже без глубоких знаний TypeScript и WebRTC. Мы убираем сложные технические детали "под капот" и оставляем снаружи только простую и понятную логику (принцип KISS). Мы также убираем дублирование кода (принцип DRY).

---

### Что делаем в этом шаге
Мы превращаем хук `useSignaling` из простого "подписчика" в полноценного менеджера общения с сервером.

### Зачем это нужно
Сейчас в файле `useCallSession.ts` (главный файл звонка) очень много кода, который занимается ручной пересылкой сообщений: "Если пришло сообщение типа 'offer', то передай его в WebRTC...". Это "загрязняет" главный файл.
Мы спрячем всю логику WebSocket (отправка, прием, переподключение) внутри `useSignaling`.

### Какие файлы меняем
- `frontend/src/hooks/useSignaling.ts`

### Пример кода

Новый `useSignaling` будет возвращать удобные функции для отправки команд и само состояние сокета.

```typescript
// frontend/src/hooks/useSignaling.ts
import { useState, useEffect, useCallback, useRef } from 'react';
import { subscribeToSignaling, SignalingSubscription } from '../services/signaling';
// ... импорты типов

export function useSignaling(callId: string, peerId?: string) {
  const [isReady, setIsReady] = useState(false); // Сокет подключен и готов?
  const socketRef = useRef<SignalingSubscription | null>(null);

  // Очередь сообщений (если нужно отправить что-то, пока сокет еще не готов)
  // Это хорошая практика, чтобы не терять сообщения при старте
  const messageQueue = useRef<any[]>([]);

  // События, на которые могут подписаться другие части приложения
  // Используем Ref, чтобы не пересоздавать подписки
  const handlers = useRef({
    onOffer: (data: any) => {},
    onAnswer: (data: any) => {},
    onCandidate: (data: any) => {},
    onPeerLeft: () => {},
    onPeerJoined: () => {}
  });

  // Функция для установки обработчиков событий
  const setHandlers = useCallback((newHandlers: Partial<typeof handlers.current>) => {
    handlers.current = { ...handlers.current, ...newHandlers };
  }, []);

  // Функция отправки сообщений (упрощенная)
  const send = useCallback((type: string, payload: any) => {
    if (socketRef.current && isReady) {
      socketRef.current.client.send({ type, data: payload });
    } else {
      console.log('Socket not ready, queuing', type);
      messageQueue.current.push({ type, data: payload });
    }
  }, [isReady]);

  useEffect(() => {
    if (!callId) return;

    const sub = subscribeToSignaling(callId, peerId, {
      onOpen: () => {
        setIsReady(true);
        // Отправляем всё, что накопилось в очереди
        messageQueue.current.forEach(msg => sub.client.send(msg));
        messageQueue.current = [];
      },
      onOffer: (msg) => handlers.current.onOffer(msg.data),
      onAnswer: (msg) => handlers.current.onAnswer(msg.data),
      onIceCandidate: (msg) => handlers.current.onCandidate(msg.data),
      onLeave: () => handlers.current.onPeerLeft(),
      onJoin: () => handlers.current.onPeerJoined(),
      // ... обработка ошибок и закрытия
      onClose: () => setIsReady(false),
    });

    socketRef.current = sub;

    return () => {
      sub.unsubscribe();
      setIsReady(false);
    };
  }, [callId, peerId]);

  return {
    isReady,
    sendOffer: (offer: any) => send('offer', offer),
    sendAnswer: (answer: any) => send('answer', answer),
    sendCandidate: (candidate: any) => send('ice-candidate', candidate),
    setHandlers // Позволяет главному хуку подписаться на события
  };
}
```

### Почему это упрощает жизнь
В главном файле `useCallSession` нам больше не нужно писать огромный `switch` для обработки сообщений. Мы просто скажем: `signaling.setHandlers({ onOffer: ... })`.

---

### Подробные подшаги выполнения

#### 2.1. Подготовка файла
- **Что сделать**: Открыть `frontend/src/hooks/useSignaling.ts`.
- **Зачем**: Мы будем полностью переписывать логику этого хука.

#### 2.2. Очистка и Импорты
- **Что сделать**: Удалить старую реализацию. Импортировать `useRef`, `useState`, `useEffect`, `useCallback` из React и функцию `subscribeToSignaling` из сервиса.
- **Зачем**: Нам нужна чистая основа для новой логики.

#### 2.3. Создание структуры хука
- **Что сделать**: Объявить функцию `useSignaling(callId: string, peerId?: string)`.
- **Как**: Внутри создать `useState` для флага `isReady` (готовность сокета) и `useRef` для хранения самого объекта подписки.

#### 2.4. Реализация очереди сообщений
- **Что сделать**: Добавить `useRef` для массива `messageQueue`.
- **Зачем**: Если компонент захочет отправить сообщение до того, как WebSocket соединится, мы сохраним сообщение здесь и отправим позже. Это решит частую проблему "гонок" при старте.

#### 2.5. Реализация обработчиков (Handlers)
- **Что сделать**: Создать `useRef` объект `handlers`, где будут лежать функции-коллбэки (`onOffer`, `onAnswer`...).
- **Как**: Добавить метод `setHandlers`, который позволит внешнему коду (менеджеру WebRTC) обновлять эти коллбэки.

#### 2.6. Подключение к сервису (useEffect)
- **Что сделать**: Написать `useEffect`, который вызывает `subscribeToSignaling`.
- **Как**:
    - В `onOpen`: ставить `isReady(true)` и отправлять очередь сообщений.
    - В `onOffer`/`onAnswer` и т.д.: вызывать соответствующие функции из `handlers.ref`.
    - В `return` (очистка): вызывать `unsubscribe()`.

#### 2.7. Возврат API
- **Что сделать**: Вернуть из хука объект с методами `sendOffer`, `sendAnswer`, `sendCandidate`, `setHandlers` и свойством `isReady`.
- **Результат**: Хук готов к использованию как "черный ящик" для сети.
