// Tracking da motorista em SEGUNDO PLANO (funciona com o Waze/Google Maps aberto).
// Requer build nativa (dev/produção) — não funciona no Expo Go — e permissão
// de posição "Sempre". Envia para o mesmo endpoint do modo online.
// Estilo mundo real (Uber/Bolt): adaptativo — 5s/10m com viagem ativa,
// 10s/20m online parada. Poupa bateria + Workers + Neon.
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { driversApi } from './api';

export const DRIVER_BG_TASK = 'ladiesgo-driver-location';
const ACTIVE_TRIP_KEY = 'lg_driver_active_trip';
const LAST_SEND_KEY = 'lg_driver_last_send';

export async function setDriverActiveTrip(active: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, active ? '1' : '0');
  } catch {}
}

async function isTripActive(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(ACTIVE_TRIP_KEY)) === '1';
  } catch {
    return false;
  }
}

function havKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const t = Math.PI / 180;
  const dLa = (bLat - aLat) * t;
  const dLo = (bLng - aLng) * t;
  const s =
    Math.sin(dLa / 2) * Math.sin(dLa / 2) +
    Math.cos(aLat * t) * Math.cos(bLat * t) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Tem de estar no topo do módulo para o SO a reativar depois de reinícios.
TaskManager.defineTask(DRIVER_BG_TASK, async ({ data, error }: any) => {
  if (error) return;
  try {
    const locations = data?.locations as Location.LocationObject[] | undefined;
    const last = locations && locations.length ? locations[locations.length - 1] : null;
    if (!last) return;
    const lat = last.coords.latitude;
    const lng = last.coords.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const active = await isTripActive();
    const minIntervalMs = active ? 5000 : 10000;
    const minDistanceM = active ? 10 : 20;

    const now = Date.now();
    try {
      const raw = await AsyncStorage.getItem(LAST_SEND_KEY);
      if (raw) {
        const prev = JSON.parse(raw) as { ts: number; lat: number; lng: number };
        const dt = now - prev.ts;
        const movedM = havKm(prev.lat, prev.lng, lat, lng) * 1000;
        // Força envio a cada 60s mesmo parada (mantém presença online).
        if (dt < minIntervalMs && movedM < minDistanceM) return;
        if (movedM < minDistanceM && dt < 60000) return;
      }
    } catch {}
    await driversApi.updateLocation(lat, lng);
    try {
      await AsyncStorage.setItem(LAST_SEND_KEY, JSON.stringify({ ts: now, lat, lng }));
    } catch {}
  } catch {
    // Sem rede ou sem sessão: ignora, a próxima atualização tenta de novo.
  }
});

export async function isDriverBgTracking(): Promise<boolean> {
  try {
    return await Location.hasStartedLocationUpdatesAsync(DRIVER_BG_TASK);
  } catch {
    return false;
  }
}

function bgOptions(): any {
  return {
    accuracy: Location.Accuracy.BestForNavigation,
    timeInterval: 5000,
    distanceInterval: 20,
    activityType: Location.ActivityType.AutomotiveNavigation,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'LadiesGo motorista',
      notificationBody: 'A partilhar a tua posição com as passageiras.',
        notificationColor: '#61188E',
    },
  };
}

// Arranca o tracking. Pede primeiro "enquanto usas" e depois "sempre".
// No Android 11+ o pedido de fundo abre as Definições — explica antes à motorista.
// No iOS exige localização EXATA (não aproximada) e a opção "Sempre".
export async function startDriverBgTracking(): Promise<void> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') throw new Error('foreground-denied');
  const precise = (fg as any)?.ios?.accuracy;
  if (precise === 'reduced') throw new Error('precise-denied');
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== 'granted') throw new Error('background-denied');
  if (await isDriverBgTracking()) return;
  await Location.startLocationUpdatesAsync(DRIVER_BG_TASK, bgOptions());
}

// Retoma sem pedir nada (só se a permissão de fundo já existir).
export async function ensureDriverBgTracking(): Promise<boolean> {
  try {
    const bg = await Location.getBackgroundPermissionsAsync();
    if (bg.status !== 'granted') return false;
    if (await isDriverBgTracking()) return true;
    await Location.startLocationUpdatesAsync(DRIVER_BG_TASK, bgOptions());
    return true;
  } catch {
    return false;
  }
}

export async function stopDriverBgTracking(): Promise<void> {
  try {
    if (await isDriverBgTracking()) {
      await Location.stopLocationUpdatesAsync(DRIVER_BG_TASK);
    }
  } catch {
    // noop
  }
}
