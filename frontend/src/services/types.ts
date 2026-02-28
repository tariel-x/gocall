export interface TurnConfig {
  iceServers?: RTCIceServer[];
}

export interface ClientConfig {
  debug: boolean;
}

export type CallStatus = 'waiting' | 'active' | 'ended';
export type ReconnectionState = 'connected' | 'reconnecting' | 'peer-disconnected' | 'failed';
export type WSState = 'connecting' | 'reconnecting' | 'ready' | 'disconnected';
export type MediaRouteMode = 'unknown' | 'direct' | 'relay';
export type WebRTCTransientStatus =
  | 'recreating-pc'
  | 'peer-disconnected'
  | 'peer-reconnected'
  | 'peer-reconnected-waiting'
  | 'renegotiate-request'
  | 'offer-sent'
  | 'answer-waiting'
  | 'retry-scheduled'
  | 'signaling-wait'
  | null;

export type CallGlobalState =
  | 'IDLE'              // Initial status
  | 'MEDIA_LOADING'     // Looking for camera/mic
  | 'SIGNALING_CONNECT' // Connecting to WS
  | 'WAITING_FOR_PEER'  // 
  | 'NEGOTIATING'       // Establishing connection
  | 'ACTIVE'            // Call is active
  | 'RECONNECTING'      // 
  | 'COMPLETED'         // 
  | 'FAILED';           // 

// Unified call state for UI (STEP_1)
export type AppCallState = CallGlobalState;

export interface CallSessionState {
  status: CallGlobalState;      // Current state
  error: string | null;      // Error if persist
}

export interface CallResponse {
  call_id: string;
  status: CallStatus;
}

export interface CallDetailsResponse extends CallResponse {
  participants: {
    count: number;
  };
}

export interface CallSessionDetails {
  wsState: WSState;
  callStatus: CallStatus;
  participants: number;
  peerConnectionState: RTCPeerConnectionState | 'new';
  iceConnectionState: RTCIceConnectionState | 'new';
  mediaRoute: { mode: MediaRouteMode; detail?: string };
  reconnectionState: ReconnectionState;
  peerDisconnected: boolean;
  transientStatus: { code: WebRTCTransientStatus; context?: any } | null;
  error: string | null;
  remoteStream: MediaStream | null;
}

export type PeerRole = 'host' | 'guest';

export interface JoinResponse {
  call_id: string;
  peer_id: string;
}

declare global {
  interface Window {
    API_ADDRESS?: string;
  }
}

export { };
