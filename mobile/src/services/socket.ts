import { io, Socket } from 'socket.io-client';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BASE_URL = (
  process.env.EXPO_PUBLIC_API_URL || 'https://ladiesgo-api.ladiesgo-ao.workers.dev/api/v1'
).replace('/api/v1', '');

class SocketService {
  private socket: Socket | null = null;

  async connect(): Promise<void> {
    if (this.socket?.connected) return;

    const token = await AsyncStorage.getItem('accessToken');

    if (this.socket) {
      this.socket.auth = { token };
      this.socket.connect();
    } else {
      this.socket = io(`${BASE_URL}/trips`, {
        auth: { token },
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 2000,
      });
    }

    return new Promise((resolve, reject) => {
      const onConnect = () => {
        this.socket!.off('connect_error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        this.socket!.off('connect', onConnect);
        reject(err);
      };
      this.socket!.once('connect', onConnect);
      this.socket!.once('connect_error', onError);
    });
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }

  emit(event: string, data?: any): void {
    this.socket?.emit(event, data);
  }

  on(event: string, cb: (...args: any[]) => void): void {
    this.socket?.on(event, cb);
  }

  off(event: string, cb?: (...args: any[]) => void): void {
    if (cb) {
      this.socket?.off(event, cb);
    } else {
      this.socket?.removeAllListeners(event);
    }
  }

  get connected(): boolean {
    return this.socket?.connected ?? false;
  }
}

export const socketService = new SocketService();
