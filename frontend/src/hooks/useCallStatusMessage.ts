import { useMemo } from 'react';
import { UseCallSessionState } from './useCallSession';

interface CallStatusMessages {
  infoMessage: string | null;
  reconnectionLabel: string | null;
}

export function useCallStatusMessage(state: UseCallSessionState): CallStatusMessages {
  return useMemo(() => {
    const {
      transientMessage,
      reconnectionState,
      peerDisconnected,
      callStatus,
      remoteStream,
      error,
      peerConnectionState,
      iceConnectionState,
      participants,
    } = state;

    let reconnectionLabel: string | null = null;
    switch (reconnectionState) {
      case 'reconnecting':
        reconnectionLabel = 'Переподключение...';
        break;
      case 'peer-disconnected':
        reconnectionLabel = 'Собеседник отключён';
        break;
      case 'failed':
        reconnectionLabel = 'Восстановление не удалось';
        break;
      default:
        reconnectionLabel = null;
    }

    let infoMessage: string | null = null;

    if (transientMessage) {
      infoMessage = transientMessage;
    } else if (reconnectionState === 'peer-disconnected' || peerDisconnected) {
      infoMessage = 'Собеседник отключился. Ждём переподключения...';
    } else if (reconnectionState === 'reconnecting') {
      infoMessage = 'Переподключаем соединение...';
    } else if (reconnectionState === 'failed') {
      infoMessage = 'Не удалось восстановить соединение. Попробуйте перезапустить звонок.';
    } else if (callStatus === 'ended') {
      infoMessage = 'Звонок завершён.';
    } else if (remoteStream && !error) {
      infoMessage = 'Видео собеседника подключено.';
    } else if (
      !error &&
      callStatus === 'active' &&
      peerConnectionState === 'connected' &&
      (iceConnectionState === 'connected' || iceConnectionState === 'completed')
    ) {
      infoMessage = 'Соединение установлено.';
    } else if (callStatus === 'active' && participants >= 2) {
      infoMessage = 'Собеседник подключился. Устанавливаем медиасоединение...';
    } else {
      infoMessage = 'Готовим звонок…';
    }

    return { infoMessage, reconnectionLabel };
  }, [state]);
}
