import type { CameraRef } from '@maplibre/maplibre-react-native';

// Estilo claro CARTO "Positron" (bom contraste de dia em Luanda, mesma
// estratégia da web que usa OSM standard + fallback CARTO light).
// Attribution "© OpenStreetMap © CARTO" is shown via <MapAttribution />.
export const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

// Fit the camera around a set of [lng, lat] coordinates (replaces
// react-native-maps fitToCoordinates). Padding is in screen points.
export function fitCoordinates(
  camera: CameraRef | null,
  coords: [number, number][],
  padding: { top: number; right: number; bottom: number; left: number },
) {
  if (!camera || coords.length === 0) return;
  const lngs = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  // Small margin so two near-identical points don't zoom in to street level
  const m = 0.0015;
  camera.fitBounds(
    [Math.min(...lngs) - m, Math.min(...lats) - m, Math.max(...lngs) + m, Math.max(...lats) + m],
    { padding, duration: 500 },
  );
}

// GeoJSON LineString between two [lng, lat] points, for route lines
export function lineBetween(a: [number, number], b: [number, number]) {
  return {
    type: 'Feature' as const,
    properties: {},
    geometry: { type: 'LineString' as const, coordinates: [a, b] },
  };
}
