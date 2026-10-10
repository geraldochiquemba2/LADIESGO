import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const BG_LOCATION_TASK = 'ladiesgo-bg-location';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'https://ladiesgo.onrender.com/api/v1';

interface BgState {
  jwt: string | null;
  userId: string | null;
  role: string | null;
  name: string | null;
  tripId: string | null;
  online: boolean;
}

// Corre em fundo (e com a app fechada em 2º plano): lê o estado guardado
// pela bridge do site e publica o GPS sem o site estar visível.
// - Motorista online (ou com viagem ativa) -> POST /drivers/position
// - Passageira ou motorista COM viagem ativa -> POST /trips/:id/position
// Sem sessão guardada, não faz nada (poupa bateria).
TaskManager.defineTask(BG_LOCATION_TASK, async ({ data, error }) => {
  if (error) return;
  const locations = (data as any)?.locations;
  const loc = Array.isArray(locations) && locations.length ? locations[0] : null;
  if (!loc) return;
  try {
    const raw = await AsyncStorage.getItem('lg_bg_state');
    if (!raw) return;
    const st = JSON.parse(raw) as BgState;
    if (!st.jwt || !st.userId) return;
    const lat = Number(loc.coords?.latitude);
    const lng = Number(loc.coords?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (st.role === 'DRIVER' && (st.online || st.tripId)) {
      try {
        await fetch(API_URL + '/drivers/position', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: st.userId, name: st.name || 'Motorista', lat, lng }),
        });
      } catch {}
    }
    if (st.tripId) {
      try {
        await fetch(API_URL + '/trips/' + st.tripId + '/position', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + st.jwt, 'Content-Type': 'application/json' },
          body: JSON.stringify({ lat, lng }),
        });
      } catch {}
    }
  } catch {}
});
