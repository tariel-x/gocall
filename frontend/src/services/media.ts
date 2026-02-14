let localStream: MediaStream | null = null;

export const hasLocalStream = (): boolean => Boolean(localStream && localStream.active);

export const getLocalStream = (): MediaStream | null => localStream;

export const releaseLocalStream = (): void => {
  if (!localStream) {
    return;
  }
  localStream.getTracks().forEach((track) => track.stop());
  localStream = null;
};

export const acquireLocalMedia = async (): Promise<MediaStream> => {
  if (hasLocalStream()) {
    return localStream as MediaStream;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Браузер не поддерживает getUserMedia');
  }
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  return localStream;
};
