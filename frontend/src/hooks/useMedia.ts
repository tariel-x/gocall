import { useEffect, useState } from 'react';
import { acquireLocalMedia, hasLocalStream } from '../services/media';

export type MediaState = 'idle' | 'pending' | 'granted' | 'error';

export const useMediaPermissions = () => {
  const [mediaState, setMediaState] = useState<MediaState>('idle');
  const [mediaError, setMediaError] = useState<string | null>(null);

  useEffect(() => {
    if (hasLocalStream()) {
      setMediaState('granted');
    }
  }, []);

  const requestMedia = async () => {
    if (mediaState === 'pending') {
      return;
    }
    setMediaState('pending');
    setMediaError(null);
    try {
      await acquireLocalMedia();
      setMediaState('granted');
    } catch (err) {
      setMediaState('error');
      if (err instanceof Error) {
        setMediaError(err.message);
      } else {
        setMediaError('Не удалось получить доступ к устройствам.');
      }
    }
  };

  return { mediaState, mediaError, requestMedia };
};
