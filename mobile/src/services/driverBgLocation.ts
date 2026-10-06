// Tracking da motorista em SEGUNDO PLANO (funciona com o Waze/Google Maps aberto).
// Requer build nativa (dev/produção) — não funciona no Expo Go — e permissão
// de posição "Sempre". Envia para o mesmo endpoint do modo online.
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import { driversApi } from './api';

export const DRIVER_BG_TASK = 'ladiesgo-driver-location';

// Tem de estar no topo do módulo para o SO a reativar depois de reinícios.
TaskManager.defineTask(DRIVER_BG_TASK, async ({ data, error }: any) => {
  if (error) return;
  try {
    const locations = data?.locations as Location.LocationObject[] | undefined;
    const last = locations && locations.length ? locations[locations.length - 1] : null;
    if (!last) return;
    await driversApi.updateLocation(last.coords.latitude, last.coords.longitude);
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
      notificationColor: '#5b21c9',
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
