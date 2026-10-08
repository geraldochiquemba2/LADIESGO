import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'https://ladiesgo.onrender.com/api/v1';

const api = axios.create({ baseURL: API_URL, timeout: 25000 });

api.interceptors.request.use(async (config) => {
  const token = await AsyncStorage.getItem('accessToken');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

let isRefreshing = false;

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && !original._retry && !original.url?.includes('refresh-token')) {
      if (isRefreshing) {
        await AsyncStorage.removeItem('accessToken');
        return Promise.reject(error);
      }
      original._retry = true;
      isRefreshing = true;
      try {
        const token = await AsyncStorage.getItem('accessToken');
        if (token) {
          const res = await api.post('/auth/refresh-token', {}, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const newToken = res.data.accessToken;
          await AsyncStorage.setItem('accessToken', newToken);
          original.headers.Authorization = `Bearer ${newToken}`;
          return api(original);
        }
      } catch {
        await AsyncStorage.removeItem('accessToken');
      } finally {
        isRefreshing = false;
      }
    }
    return Promise.reject(error);
  },
);

export const authApi = {
  guest: (name?: string) => api.post('/auth/guest', { name }),
  login: (phone: string, password: string) => api.post('/auth/login', { phone, password }),
  changePassword: (newPassword: string) => api.post('/auth/change-password', { newPassword }),
};

export const usersApi = {
  getProfile: () => api.get('/users/profile'),
  updateProfile: (data: any) => api.put('/users/profile', data),
  getTripHistory: (page = 1) => api.get(`/users/trips/history?page=${page}`),
};

export const driversApi = {
  register: (data: any) => api.post('/drivers/register', data),
  getStatus: () => api.get('/drivers/status'),
  toggleOnline: (isOnline: boolean) => api.put('/drivers/toggle-online', { isOnline }),
  updateLocation: (lat: number, lng: number) => api.put('/drivers/location', { lat, lng }),
  // Aceita os dois formatos: {drivers:[...]} (web/LadiesGo) ou [...] (legado).
  // Normaliza sempre para array com currentLat/currentLng.
  getNearby: async (lat: number, lng: number) => {
    const res = await api.get(`/drivers/nearby?lat=${lat}&lng=${lng}`);
    const raw = ((res.data as any)?.drivers ?? res.data ?? []) as any[];
    res.data = raw.map((d) => ({ ...d, currentLat: d.currentLat ?? d.lat, currentLng: d.currentLng ?? d.lng }));
    return res;
  },
  getEarnings: (page = 1) => api.get(`/drivers/earnings?page=${page}`),
};

export const tripsApi = {
  estimate: (data: any) => api.post('/trips/estimate', data),
  request: (data: any) => api.post('/trips/request', data),
  getActive: () => api.get('/trips/active'),
  getTrip: (id: string) => api.get(`/trips/${id}`),
  accept: (id: string) => api.put(`/trips/${id}/accept`),
  markArrived: (id: string) => api.put(`/trips/${id}/arrived`),
  start: (id: string) => api.put(`/trips/${id}/start`),
  complete: (id: string) => api.put(`/trips/${id}/complete`),
  cancel: (id: string, reason?: string) => api.put(`/trips/${id}/cancel`, { reason }),
};

export const ratingsApi = {
  create: (data: any) => api.post('/ratings', data),
};

export const notificationsApi = {
  getAll: (page = 1) => api.get(`/notifications?page=${page}`),
  getUnreadCount: () => api.get('/notifications/unread-count'),
  markAllRead: () => api.put('/notifications/read-all'),
};

export const paymentsApi = {
  createIntent: (tripId: string) => api.post('/payments/create-intent', { tripId }),
  confirm: (tripId: string) => api.post('/payments/confirm', { tripId }),
};

export default api;
