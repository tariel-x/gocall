# STEP 3: Рефакторинг useWebRTCManager (Черный ящик WebRTC)

### Общая задача рефакторинга
Наша цель — упростить код видеозвонков так, чтобы он был понятен любому разработчику, даже без глубоких знаний TypeScript и WebRTC. Мы убираем сложные технические детали "под капот" и оставляем снаружи только простую и понятную логику (принцип KISS). Мы также убираем дублирование кода (принцип DRY).

---

### Что делаем в этом шаге
Мы переписываем `useWebRTCManager`, чтобы он стал полностью самостоятельным "черным ящиком". Он будет сам решать, когда нужно пересоздать соединение (ICE Restart), сам следить за состоянием и сам обмениваться техническими сообщениями через `signaling`.

### Зачем это нужно
Сейчас главный компонент должен вручную "скармливать" сигналы в WebRTC менеджер (`void processSignal('offer', ...)`). Это неправильно. Менеджер соединений должен сам знать, что делать с этими сигналами. Наружу он должен выдавать только "Соединение есть" или "Соединения нет".

### Какие файлы меняем
- `frontend/src/hooks/useWebRTCManager.ts`

### Пример кода

Мы передадим в `useWebRTCManager` объект `signaling` из предыдущего шага, и менеджер сам подпишется на нужные события.

```typescript
// frontend/src/hooks/useWebRTCManager.ts
import { useEffect, useRef, useState, useReducer } from 'react';
// Импортируем типы из нашего нового Signaling
import { useSignaling } from './useSignaling'; 

interface UseWebRTCManagerProps {
  localStream: MediaStream | null;
  signaling: ReturnType<typeof useSignaling>; // Передаем результат работы хука сигналинга
  isHost: boolean; // Кто мы: инициатор (host) или гость
}

export function useWebRTCManager({ localStream, signaling, isHost }: UseWebRTCManagerProps) {
  // Внутреннее состояние WebRTC, которое не нужно знать наружу в деталях
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'new' | 'connecting' | 'connected' | 'failed'>('new');
  
  const pcRef = useRef<RTCPeerConnection | null>(null);

  // Функция инициализации (создание PeerConnection)
  const initPC = async () => {
    // 1. Получаем конфиг (STUN/TURN)
    // 2. Создаем new RTCPeerConnection(...)
    // 3. Добавляем треки из localStream
    
    // 4. Подписываемся на ICE кандидаты и отправляем их через signaling
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        signaling.sendCandidate(event.candidate); // ПРЯМО ЗДЕСЬ, не в родительском компоненте
      }
    };

    pc.ontrack = (event) => {
      setRemoteStream(event.streams[0]);
    };
    
    // ... обработка изменения состояний ...
  };

  // Эффект, который реагирует на сигналы от сервера
  useEffect(() => {
    // Говорим сигналингу: "Если придет Offer, отдай его мне"
    signaling.setHandlers({
      onOffer: async (offer) => {
        // Тут логика: setRemoteDescription -> createAnswer -> setLocalDescription -> signaling.sendAnswer
      },
      onAnswer: async (answer) => {
        // Тут логика: setRemoteDescription
      },
      onCandidate: async (candidate) => {
         // Тут логика: addIceCandidate
      }
    });
  }, [signaling, pcRef.current]); // Зависимости

  // Эффект для старта звонка (только для хоста)
  useEffect(() => {
    if (isHost && signaling.isReady && !pcRef.current) {
       // Создать offer и отправить
    }
  }, [isHost, signaling.isReady]);

  return {
    remoteStream,
    connectionStatus, // Простое состояние: подключились или нет
    restart: () => { /* Логика перезапуска */ }
  };
}
```

### Почему это упрощает жизнь
`useCallSession.ts` больше не будет знать, что такое `SDP Offer`, `Answer` или `ICE Candidate`. Он просто скажет: `useWebRTCManager({ signaling, ... })` и получит `remoteStream`. Вся "грязная" работа останется внутри менеджера.

---

### Подробные подшаги выполнения

#### 3.1. Изменение сигнатуры
- **Что сделать**: Открыть `frontend/src/hooks/useWebRTCManager.ts`. Изменить принимаемые параметры на `{ localStream, signaling, isHost }`.
- **Зачем**: Теперь менеджер получает доступ к сети через объект `signaling`, а не через коллбэк `sendSignal`.

#### 3.2. Упрощение состояния
- **Что сделать**: Заменить множество состояний (`iceConnectionState`, `peerConnectionState`) на одно упрощенное `connectionStatus` ('new' | 'connecting' | 'connected' | 'failed').
- **Зачем**: Внешнему миру не нужны детали, ему нужно знать, есть коннект или нет.

#### 3.3. Интеграция с Signaling
- **Что сделать**: Добавить `useEffect`, который вызывает `signaling.setHandlers({...})`.
- **Как**: Внутри обработчиков (`onOffer`, `onAnswer`) вызывать методы PeerConnection (`setRemoteDescription` и т.д.).
- **Важно**: Это ключевой момент инверсии управления. Раньше родитель управлял сигналами, теперь сам менеджер.

#### 3.4. Автоматическая отправка ICE кандидатов
- **Что сделать**: В момент создания `new RTCPeerConnection`, в `onicecandidate` вызывать `signaling.sendCandidate(...)`.
- **Зачем**: Чтобы кандидаты улетали собеседнику сразу же, автоматически.

#### 3.5. Логика Host/Guest
- **Что сделать**: Добавить `useEffect` с зависимостью `[isHost, signaling.isReady]`.
- **Как**: Если `isHost` и `signaling.isReady` — создать Offer, установить LocalDescription и вызвать `signaling.sendOffer()`.
- **Результат**: Звонок будет начинаться сам, как только сеть готова.

#### 3.6. Функция Restart
- **Что сделать**: Реализовать метод `restart`, который закрывает текущее соединение, создает новое и (если хост) заново шлет Offer.
