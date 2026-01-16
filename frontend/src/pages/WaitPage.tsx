import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getCall } from '../services/api';
import { setCallContext } from '../services/session';
import type { CallStatus } from '../services/types';
import { useMediaPermissions } from '../hooks/useMedia';
import { useSignaling } from '../hooks/useSignaling';

const WaitPage = () => {
  const { callId } = useParams<{ callId: string }>();
  const navigate = useNavigate();

  const [callStatus, setCallStatus] = useState<CallStatus>('waiting');
  const [participants, setParticipants] = useState(1);
  const [isFetchingCall, setIsFetchingCall] = useState(true);
  const [callError, setCallError] = useState<string | null>(null);

  const { mediaState, mediaError, requestMedia } = useMediaPermissions();
  const { wsState } = useSignaling({
    callId,
    onState: (status, count) => {
      setCallStatus(status);
      setParticipants(count);
      if (status === 'active' && callId) {
        navigate(`/call/${callId}`);
      }
    },
  });

  useEffect(() => {
    if (!callId) {
      setCallError('Не указан идентификатор звонка.');
      return;
    }
    setCallContext(callId);
    let cancelled = false;
    setIsFetchingCall(true);
    getCall(callId)
      .then((response) => {
        if (cancelled) {
          return;
        }
        setCallStatus(response.status);
        setParticipants(response.participants?.count ?? 1);
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 404) {
          setCallError('Звонок не найден или уже завершён.');
          return;
        }
        if (err instanceof Error) {
          setCallError(err.message);
          return;
        }
        setCallError('Не удалось получить информацию о звонке.');
      })
      .finally(() => {
        if (!cancelled) {
          setIsFetchingCall(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [callId]);

  const joinURL = useMemo(() => {
    if (!callId) {
      return '';
    }
    return `${window.location.origin}/newui/join/${callId}`;
  }, [callId]);

  if (!callId) {
    return (
      <main className="page">
        <h1>Ожидание подключения</h1>
        <p className="page-error">Не удалось определить ID звонка.</p>
        <button className="primary-button" onClick={() => navigate('/')}>Создать новый звонок</button>
      </main>
    );
  }

  if (callError) {
    return (
      <main className="page">
        <h1>Звонок недоступен</h1>
        <p className="page-error">{callError}</p>
        <button className="primary-button" onClick={() => navigate('/')}>Создать новый звонок</button>
      </main>
    );
  }

  return (
    <main className="page wait-page">
      <h1>Ожидание подключения</h1>
      <p>Звонок создан. Поделитесь ссылкой с собеседником.</p>
      <div className="status-card">
        <div className="status-row">
          <span className="status-label">Статус:</span>
          <span className={`status-badge status-${callStatus}`}>
            {callStatus === 'waiting' && 'Ждём участника'}
            {callStatus === 'active' && 'Звонок в процессе'}
            {callStatus === 'ended' && 'Звонок завершён'}
          </span>
        </div>
        <div className="status-row">
          <span className="status-label">Подключено:</span>
          <span>{participants}/2</span>
        </div>
        <div className="status-row">
          <span className="status-label">Сигналинг:</span>
          <span className={`status-badge status-${wsState}`}>
            {wsState === 'connecting' && 'Подключаемся...'}
            {wsState === 'ready' && 'Соединение установлено'}
            {wsState === 'disconnected' && 'Разъединено'}
          </span>
        </div>
      </div>

      <section className="share-block">
        <h2>Ссылка для приглашения</h2>
        <p className="join-link">{joinURL}</p>
      </section>

      <section className="media-block">
        <h2>Доступ к камере и микрофону</h2>
        <p>
          Чтобы ускорить начало звонка, разрешите использование камеры и микрофона заранее. Если браузер отклонил автоматический запрос, нажмите кнопку ниже.
        </p>
        <button className="secondary-button" disabled={mediaState === 'pending' || mediaState === 'granted'} onClick={requestMedia}>
          {mediaState === 'granted' ? 'Доступ предоставлен' : mediaState === 'pending' ? 'Запрашиваем...' : 'Разрешить устройства'}
        </button>
        {mediaError && <p className="page-error">{mediaError}</p>}
      </section>

      {isFetchingCall && <p className="page-meta">Проверяем состояние звонка…</p>}
    </main>
  );
};

export default WaitPage;
