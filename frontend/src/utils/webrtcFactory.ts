/**
 * Creates a new RTCPeerConnection and adds local tracks if available.
 */
export function createConfiguredPeerConnection(
  config: RTCConfiguration,
  localStream: MediaStream | null
): RTCPeerConnection {
  const pc = new RTCPeerConnection(config);

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });
  }

  return pc;
}
