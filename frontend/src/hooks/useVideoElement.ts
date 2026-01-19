import { useEffect, RefObject } from 'react';

interface UseVideoElementOptions {
  muted?: boolean;
  playsInline?: boolean;
}

/**
 * Хук для привязки MediaStream к HTMLVideoElement.
 * Автоматически устанавливает srcObject и запускает воспроизведение.
 */
export function useVideoElement(
  ref: RefObject<HTMLVideoElement>,
  stream: MediaStream | null,
  options: UseVideoElementOptions = {}
): void {
  const { muted = false, playsInline = true } = options;

  useEffect(() => {
    const video = ref.current;
    if (!video) {
      return;
    }

    video.muted = muted;
    video.playsInline = playsInline;
    video.srcObject = stream ?? null;

    if (stream) {
      void video.play().catch(() => {
        // Игнорируем ошибки автоплея (браузер может блокировать)
      });
    }
  }, [ref, stream, muted, playsInline]);
}
