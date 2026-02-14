export interface TurnConfig {
  iceServers?: RTCIceServer[];
}

export type CallStatus = 'waiting' | 'active' | 'ended';
export type ReconnectionState = 'connected' | 'reconnecting' | 'peer-disconnected' | 'failed';

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

export {};
