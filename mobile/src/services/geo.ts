// Estratégia de localizações trazida da web (ladiesgo-home.html):
// - Luanda como origem padrão, GPS só aceite perto de Luanda (<150 km)
// - Nome do ponto via /api/zone (backend) com fallback Nominatim
// - Rota real via /api/route (proxy OSRM) com fallback OSRM direto e
//   fallback imediato em curva (curvePath) enquanto a rota carrega.

export const LUANDA_FIXA: [number, number] = [-8.839, 13.2894]; // [lat, lng]
export const LUANDA = { latitude: -8.839, longitude: 13.2894 };

// Compat: alguns ecrãs ainda usam as coordenadas antigas (Riade). Se a
// posição estiver longe de Luanda, assume-se Luanda.
export function nearLuanda(lat: number, lng: number, maxKm = 150): boolean {
  return havKm([LUANDA_FIXA[0], LUANDA_FIXA[1]], [lat, lng]) <= maxKm;
}

export function sanitizeCoord(
  lat: number,
  lng: number,
): { latitude: number; longitude: number } {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !nearLuanda(lat, lng)) {
    return { ...LUANDA };
  }
  return { latitude: lat, longitude: lng };
}

export function havKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const t = Math.PI / 180;
  const dLa = (b[0] - a[0]) * t;
  const dLo = (b[1] - a[1]) * t;
  const s =
    Math.sin(dLa / 2) * Math.sin(dLa / 2) +
    Math.cos(a[0] * t) * Math.cos(b[0] * t) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Curva quadrática imediata (fallback enquanto a rota real carrega).
// Entrada/saída em [lat, lng].
export function curvePath(a: [number, number], b: [number, number]): [number, number][] {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.sqrt(dx * dx + dy * dy) || 1e-9;
  const off = len * 0.18;
  const cx = mx + (-dy / len) * off;
  const cy = my + (dx / len) * off;
  const n = Math.max(12, Math.round(len * 111 * 4));
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push([
      u * u * a[0] + 2 * u * t * cx + t * t * b[0],
      u * u * a[1] + 2 * u * t * cy + t * t * b[1],
    ]);
  }
  return pts;
}

function apiRoot(): string {
  const base = process.env.EXPO_PUBLIC_API_URL || 'https://ladiesgo.onrender.com/api/v1';
  return base.replace(/\/api\/v1\/?$/, '');
}

export interface RouteInfo {
  /** Pontos em [lat, lng] */
  points: [number, number][];
  distanceKm: number | null;
  durationMin: number | null;
  real: boolean;
}

// Rota real pelas ruas. Devolve a curva imediata se a rede falhar.
export async function fetchRoute(
  from: [number, number],
  to: [number, number],
): Promise<RouteInfo> {
  const fallback = curvePath(from, to);
  try {
    const r = await fetch(
      `${apiRoot()}/api/route?from=${from[0]},${from[1]}&to=${to[0]},${to[1]}`,
    );
    const j = await r.json();
    if (j?.points?.length) {
      return {
        points: j.points,
        distanceKm: typeof j.distance_m === 'number' ? j.distance_m / 1000 : null,
        durationMin: typeof j.duration_s === 'number' ? j.duration_s / 60 : null,
        real: true,
      };
    }
  } catch {}
  // Fallback: OSRM público direto (como na web)
  try {
    const q = `${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson`;
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${q}`);
    const j = await r.json();
    const g = j?.routes?.[0]?.geometry?.coordinates;
    if (g?.length) {
      return {
        points: g.map((p: number[]) => [p[1], p[0]] as [number, number]),
        distanceKm: typeof j.routes[0]?.distance === 'number' ? j.routes[0].distance / 1000 : null,
        durationMin: typeof j.routes[0]?.duration === 'number' ? j.routes[0].duration / 60 : null,
        real: true,
      };
    }
  } catch {}
  return { points: fallback, distanceKm: null, durationMin: null, real: false };
}

// Nome da zona (bairro/município) para mostrar na UI.
export async function fetchZone(lat: number, lng: number): Promise<string> {
  try {
    const r = await fetch(`${apiRoot()}/api/zone?lat=${lat}&lng=${lng}`);
    const j = await r.json();
    if (j?.zone) return String(j.zone);
  } catch {}
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=14`,
      { headers: { 'User-Agent': 'LadiesGo/1.0' } },
    );
    const j = await r.json();
    const a = j?.address || {};
    const z = a.suburb || a.neighbourhood || a.quarter || a.city_district || a.town || a.city || '';
    if (z) return String(z);
  } catch {}
  return '';
}

export interface PlaceHit {
  name: string;
  lat: number;
  lng: number;
}

// Pesquisa de moradas: primeiro o índice LadiesGo no backend (23k+ locais,
// instantâneo e com os nossos nomes), Nominatim só como fallback.
export async function searchPlaces(
  q: string,
  near?: { latitude: number; longitude: number },
): Promise<PlaceHit[]> {
  const query = q.trim();
  if (query.length < 3) return [];
  try {
    const params =
      `q=${encodeURIComponent(query)}` +
      (near ? `&lat=${near.latitude}&lng=${near.longitude}` : '');
    const r = await fetch(`${apiRoot()}/api/places/search?${params}`);
    const j = await r.json();
    if (Array.isArray(j?.places) && j.places.length > 0) {
      return j.places
        .map((p: any) => ({
          name: String(p.name).split(',').slice(0, 2).join(','),
          lat: Number(p.lat),
          lng: Number(p.lng),
        }))
        .filter((p: PlaceHit) => p.name && Number.isFinite(p.lat) && Number.isFinite(p.lng));
    }
  } catch {}
  try {
    const url =
      `https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=ao` +
      `&viewbox=13.05,-8.70,13.55,-9.05&bounded=0` +
      `&accept-language=pt&q=${encodeURIComponent(query)}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'LadiesGo/1.0' } });
    const j = await r.json();
    if (!Array.isArray(j)) return [];
    return j
      .map((p: any) => ({
        name: String(p.display_name?.split(',').slice(0, 2).join(',') || p.display_name || query),
        lat: Number(p.lat),
        lng: Number(p.lon),
      }))
      .filter((p: PlaceHit) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  } catch {
    return [];
  }
}

// Converte pontos [lat, lng] em GeoJSON [lng, lat] para o MapLibre.
export function toGeoJSONLine(points: [number, number][]) {
  return {
    type: 'Feature' as const,
    properties: {},
    geometry: {
      type: 'LineString' as const,
      coordinates: points.map(([lat, lng]) => [lng, lat]),
    },
  };
}
