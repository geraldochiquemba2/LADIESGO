import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  ScrollView,
  Linking,
  Platform,
  Modal,
  TextInput,
} from 'react-native';
import {
  Map as MapLibreMap,
  Camera,
  Marker,
  GeoJSONSource,
  Layer,
  type CameraRef,
} from '@maplibre/maplibre-react-native';
import { MAP_STYLE, MAP_STYLE_FALLBACK, fitCoordinates } from '../../components/appMap';
import MapAttribution from '../../components/MapAttribution';
import { curvePath, fetchRouteLegs, toGeoJSONLine } from '../../services/geo';
import * as Location from 'expo-location';
import { socketService } from '../../services/socket';
import { tripsApi, driversApi } from '../../services/api';
import { setDriverActiveTrip } from '../../services/driverBgLocation';

type TripStatus = 'ACCEPTED' | 'DRIVER_ARRIVED' | 'IN_PROGRESS' | 'COMPLETED';

const ACTION_MAP: Record<string, { label: string; color: string }> = {
  ACCEPTED: { label: "I've Arrived at Pickup", color: '#FFD700' },
  DRIVER_ARRIVED: { label: 'Start Trip', color: '#16a34a' },
  IN_PROGRESS: { label: 'Complete Trip', color: '#2563eb' },
};

export default function ActiveTripScreen({ navigation, route }: any) {
  const { trip } = route.params as { trip: any };
  const cameraRef = useRef<CameraRef>(null);

  const [myLocation, setMyLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [heading, setHeading] = useState<number>(-1);
  const [passengerLocation, setPassengerLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [status, setStatus] = useState<TripStatus>((trip.status as TripStatus) || 'ACCEPTED');
  const [eta, setEta] = useState<{ minutes: number; distanceKm: number } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [pinModal, setPinModal] = useState(false);
  const [pin, setPin] = useState('');

  const latestMyLoc = useRef<{ lat: number; lng: number } | null>(null);
  const statusRef = useRef<TripStatus>((trip.status as TripStatus) || 'ACCEPTED');

  // Estilo do mapa com fallback (estratégia da web: OSM -> CARTO).
  const [mapStyle, setMapStyle] = useState(MAP_STYLE);

  // Rota real multi-pernas (estratégia da web: drvLegs/drvCurve + OSRM,
  // curva imediata + anti-race, refresh no máx. a cada 15s).
  const [routePoints, setRoutePoints] = useState<[number, number][]>([]);
  const [routeMeta, setRouteMeta] = useState<{ distanceKm: number | null; durationMin: number | null; real: boolean } | null>(null);
  const routeSeq = useRef(0);
  const lastRouteFetch = useRef<{ ts: number; key: string }>({ ts: 0, key: '' });

  // Paragens intermédias da viagem (tolera vários formatos).
  const tripStops = useRef<[number, number][]>([]);

  const buildWaypoints = (from: { lat: number; lng: number }, st: TripStatus): [number, number][] => {
    const pts: [number, number][] = [[from.lat, from.lng]];
    if (st === 'IN_PROGRESS') {
      for (const s of tripStops.current) pts.push(s);
      if (Number.isFinite(trip.dropoffLat) && Number.isFinite(trip.dropoffLng)) {
        pts.push([trip.dropoffLat, trip.dropoffLng]);
      }
    } else if (Number.isFinite(trip.pickupLat) && Number.isFinite(trip.pickupLng)) {
      pts.push([trip.pickupLat, trip.pickupLng]);
    }
    return pts;
  };

  const loadRouteLegs = async (from: { lat: number; lng: number }, st: TripStatus) => {
    const legs = buildWaypoints(from, st);
    if (legs.length < 2) {
      setRoutePoints([]);
      setRouteMeta(null);
      return;
    }
    const key = `${st}|` + legs.map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join('>');
    const now = Date.now();
    if (now - lastRouteFetch.current.ts < 15000 && lastRouteFetch.current.key === key) return;
    lastRouteFetch.current = { ts: now, key };
    const my = ++routeSeq.current;
    // Desenho imediato em curva por perna (não deixa o mapa vazio)
    let immediate: [number, number][] = [];
    for (let i = 1; i < legs.length; i++) {
      const seg = curvePath(legs[i - 1], legs[i]);
      immediate = immediate.concat(immediate.length ? seg.slice(1) : seg);
    }
    setRoutePoints(immediate);
    const info = await fetchRouteLegs(legs);
    if (routeSeq.current !== my) return;
    setRoutePoints(info.points);
    setRouteMeta({ distanceKm: info.distanceKm, durationMin: info.durationMin, real: info.real });
  };

  useEffect(() => {
    statusRef.current = status;
    if (latestMyLoc.current) loadRouteLegs(latestMyLoc.current, status);
  }, [status]);

  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    let lastRestTs = 0;

    const setup = async () => {
      const { status: perm } = await Location.requestForegroundPermissionsAsync();
      if (perm !== 'granted') return;
      setDriverActiveTrip(true).catch(() => {});
      if (trip?.id) {
        await socketService.connect();
        socketService.openTrip(trip.id, 'driver');
      }

      // Lê paragens guardadas na viagem (se existirem).
      try {
        const raw = (trip as any)?.stops;
        if (Array.isArray(raw)) {
          tripStops.current = raw
            .map((s: any): [number, number] | null => {
              if (s == null) return null;
              if (Array.isArray(s) && Number.isFinite(s[0]) && Number.isFinite(s[1])) return [s[0], s[1]];
              if (Number.isFinite(s?.lat) && Number.isFinite(s?.lng)) return [s.lat, s.lng];
              if (Number.isFinite(s?.latitude) && Number.isFinite(s?.longitude)) return [s.latitude, s.longitude];
              if (Array.isArray(s?.c) && Number.isFinite(s.c[0]) && Number.isFinite(s.c[1])) return [s.c[0], s.c[1]];
              return null;
            })
            .filter((p): p is [number, number] => p !== null)
            .slice(0, 3);
        }
      } catch {}

      // Viagem ativa: 5s/10m. REST throttled 5s (Workers) + socket (Render).
      sub = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 5000,
          distanceInterval: 10, // only fire when moved ≥ 10 m
        },
        (loc) => {
          const pos = { lat: loc.coords.latitude, lng: loc.coords.longitude };
          const h = loc.coords.heading ?? -1;
          latestMyLoc.current = pos;
          setMyLocation(pos);
          setHeading(h);
          socketService.emit('driver:location-update', { ...pos, heading: h });
          const now = Date.now();
          if (now - lastRestTs >= 5000) {
            lastRestTs = now;
            driversApi.updateLocation(pos.lat, pos.lng).catch(() => {});
          }
          loadRouteLegs(pos, statusRef.current);

          // Keep map centered on driver
          cameraRef.current?.easeTo({
            center: [pos.lng, pos.lat],
            zoom: 15,
            duration: 400,
          });
        },
      );

      socketService.on('server:passenger-location', (data) => {
        const pLoc = { lat: data.lat, lng: data.lng };
        setPassengerLocation(pLoc);
        setEta({ minutes: data.etaMinutes, distanceKm: data.distanceKm });

        if (latestMyLoc.current) {
          fitCoordinates(
            cameraRef.current,
            [
              [latestMyLoc.current.lng, latestMyLoc.current.lat],
              [pLoc.lng, pLoc.lat],
            ],
            { top: 80, right: 80, bottom: 320, left: 80 },
          );
        }
      });

      socketService.on('server:trip-cancelled', () => {
        Alert.alert('Viagem cancelada', 'A passageira cancelou a viagem.', [
          { text: 'OK', onPress: () => navigation.replace('DriverHome') },
        ]);
      });
    };

    setup();

    return () => {
      sub?.remove();
      setDriverActiveTrip(false).catch(() => {});
      socketService.off('server:passenger-location');
      socketService.off('server:trip-cancelled');
    };
  }, []);

  const handleAction = async () => {
    setActionLoading(true);
    try {
      if (status === 'ACCEPTED') {
        await tripsApi.markArrived(trip.id);
        setStatus('DRIVER_ARRIVED');
      } else if (status === 'DRIVER_ARRIVED') {
        // Código de segurança: a passageira dita os 4 dígitos para arrancar.
        setPin('');
        setPinModal(true);
      } else if (status === 'IN_PROGRESS') {
        await tripsApi.complete(trip.id);
        socketService.emit('driver:trip-completed', { tripId: trip.id });
        navigation.replace('DriverTripComplete', { trip });
      }
    } catch (e: any) {
      Alert.alert('Error', e.response?.data?.message || 'Action failed. Try again.');
    } finally {
      setActionLoading(false);
    }
  };

  const confirmStart = async () => {
    if (pin.trim().length < 4) {
      Alert.alert('Código', 'Pede o código de 4 dígitos à passageira para arrancar.');
      return;
    }
    setActionLoading(true);
    try {
      await tripsApi.start(trip.id, pin.trim());
      setPinModal(false);
      setStatus('IN_PROGRESS');
    } catch (e: any) {
      Alert.alert('Código incorreto', e.response?.data?.message || 'Confirma o código com a passageira.');
    } finally {
      setActionLoading(false);
    }
  };

  const targetCoord =
    status === 'IN_PROGRESS'
      ? { latitude: trip.dropoffLat, longitude: trip.dropoffLng }
      : { latitude: trip.pickupLat, longitude: trip.pickupLng };

  if (!myLocation) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#FFD700" />
      </View>
    );
  }

  const action = ACTION_MAP[status];
  const passenger = trip.passenger;
  const carRotation = heading >= 0 ? heading : 0;

  const handleSOS = () => {
    Alert.alert('Emergência', 'Ligar para emergência em Angola?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Polícia 113', style: 'destructive', onPress: () => Linking.openURL('tel:113') },
      { text: 'Bombeiros 115', onPress: () => Linking.openURL('tel:115') },
    ]);
  };

  // Open Google Maps turn-by-turn to pickup (before start) or destination (during trip)
  const handleNavigate = () => {
    const { latitude, longitude } = targetCoord;
    const nativeUrl = Platform.OS === 'android'
      ? `google.navigation:q=${latitude},${longitude}`
      : `comgooglemaps://?daddr=${latitude},${longitude}&directionsmode=driving`;
    Linking.openURL(nativeUrl).catch(() =>
      Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}&travelmode=driving`),
    );
  };

  const handleChat = () => {
    navigation.navigate('Chat', {
      tripId: trip.id,
      otherName: passenger?.name || 'Passageira',
      otherUserId: trip.passengerId || passenger?.id,
    });
  };

  return (
    <View style={styles.container}>
      <MapLibreMap
        style={styles.map}
        mapStyle={mapStyle}
        onDidFailLoadingMap={() => setMapStyle(MAP_STYLE_FALLBACK)}
        attribution={false}
        logo={false}
        compass={false}
      >
        <Camera
          ref={cameraRef}
          initialViewState={{ center: [myLocation.lng, myLocation.lat], zoom: 15 }}
        />
        {/* Driver marker — rotates with heading */}
        <Marker
          lngLat={[myLocation.lng, myLocation.lat]}
          anchor="center"
        >
          <View style={[styles.driverMarker, { transform: [{ rotate: `${carRotation}deg` }] }]}>
            <Text style={styles.driverMarkerText}>🚗</Text>
          </View>
        </Marker>

        {/* Route line: driver → pickup/stops/destino (rota real OSRM, como na web) */}
        {routePoints.length > 0 && (
          <GeoJSONSource
            id="targetRouteSource"
            data={toGeoJSONLine(routePoints)}
          >
            <Layer
              id="targetRouteLine"
              type="line"
              style={{ lineColor: '#61188E', lineWidth: 5, lineOpacity: 0.9 }}
            />
          </GeoJSONSource>
        )}

        {/* Pickup / destination pin */}
        <Marker
          lngLat={[targetCoord.longitude, targetCoord.latitude]}
          anchor="bottom"
        >
          <View style={[
            styles.targetPin,
            { backgroundColor: status === 'IN_PROGRESS' ? '#2563eb' : '#FFD700' },
          ]}>
            <Text style={styles.targetPinText}>{status === 'IN_PROGRESS' ? '🏁' : '📍'}</Text>
          </View>
        </Marker>

        {/* Live passenger location — escondida após o arranque (já vão juntas) */}
        {passengerLocation && status !== 'IN_PROGRESS' && (
          <Marker
            lngLat={[passengerLocation.lng, passengerLocation.lat]}
            anchor="center"
          >
            <View style={styles.passengerMarker}>
              <Text style={styles.passengerMarkerText}>👤</Text>
            </View>
          </Marker>
        )}
      </MapLibreMap>
      <MapAttribution />

      {/* Bottom sheet */}
      <ScrollView style={styles.sheet} contentContainerStyle={styles.sheetContent}>
        {eta ? (
          <View style={styles.etaRow}>
            <View>
              <Text style={styles.etaLabel}>
                {status === 'IN_PROGRESS' ? 'ETA to destination' : 'ETA to pickup'}
              </Text>
              <Text style={styles.etaValue}>{eta.minutes} min · {eta.distanceKm} km</Text>
              {routeMeta?.distanceKm != null && (
                <Text style={styles.routeInfo}>
                  🛣️ {routeMeta.distanceKm.toFixed(1).replace('.', ',')} km
                  {routeMeta.durationMin != null && ` · ~${Math.max(1, Math.round(routeMeta.durationMin))} min`}
                  {!routeMeta.real && ' · estimado'}
                </Text>
              )}
            </View>
          </View>
        ) : (
          <View style={styles.etaRow}>
            <Text style={styles.etaLabel}>Waiting for passenger location...</Text>
            {routeMeta?.distanceKm != null && (
              <Text style={styles.routeInfo}>
                🛣️ {routeMeta.distanceKm.toFixed(1).replace('.', ',')} km
                {routeMeta.durationMin != null && ` · ~${Math.max(1, Math.round(routeMeta.durationMin))} min`}
                {!routeMeta.real && ' · estimado'}
              </Text>
            )}
          </View>
        )}

        {passenger && (
          <View style={styles.passengerCard}>
            <Text style={styles.passengerName}>{passenger.name || 'Passenger'}</Text>
            <Text style={styles.passengerPhone}>{passenger.phone}</Text>
          </View>
        )}

        {trip.tripType === 'DELIVERY' && (
          <View style={styles.packageCard}>
            <Text style={styles.packageTitle}>📦 PACKAGE DELIVERY</Text>
            <Text style={styles.packageDesc}>{trip.packageDescription || 'Package'}</Text>
            {trip.receiverName ? (
              <Text style={styles.packageReceiver}>
                Deliver to: {trip.receiverName}
                {trip.receiverPhone ? ` · ${trip.receiverPhone}` : ''}
              </Text>
            ) : null}
            {trip.receiverPhone ? (
              <TouchableOpacity
                style={styles.callReceiverBtn}
                onPress={() => Linking.openURL(`tel:${trip.receiverPhone}`)}
              >
                <Text style={styles.callReceiverText}>📞 Call Receiver</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        )}

        <View style={styles.addressBlock}>
          <View style={styles.addressRow}>
            <Text style={styles.addrIcon}>📍</Text>
            <View style={styles.addrTexts}>
              <Text style={styles.addrLabel}>Pickup</Text>
              <Text style={styles.addrValue} numberOfLines={2}>{trip.pickupAddress}</Text>
              {trip.pickupRef ? (
                <Text style={styles.addrRef} numberOfLines={2}>🏢 {trip.pickupRef}</Text>
              ) : null}
            </View>
          </View>
          <View style={styles.addressDivider} />
          <View style={styles.addressRow}>
            <Text style={styles.addrIcon}>🏁</Text>
            <View style={styles.addrTexts}>
              <Text style={styles.addrLabel}>Dropoff</Text>
              <Text style={styles.addrValue} numberOfLines={2}>{trip.dropoffAddress}</Text>
              {trip.dropoffRef ? (
                <Text style={styles.addrRef} numberOfLines={2}>🏢 {trip.dropoffRef}</Text>
              ) : null}
            </View>
          </View>
        </View>

        <View style={styles.fareRow}>
          <Text style={styles.fareLabel}>Fare Estimate</Text>
          <Text style={styles.fareValue}>{trip.fareEstimate} Kz</Text>
        </View>

        {/* Turn-by-turn navigation in Google Maps */}
        <TouchableOpacity style={styles.navigateBtn} onPress={handleNavigate}>
          <Text style={styles.navigateText}>
            🧭 Navigate to {status === 'IN_PROGRESS' ? 'Destination' : 'Pickup'}
          </Text>
        </TouchableOpacity>

        {/* Call + Chat + SOS */}
        <View style={styles.utilRow}>
          {passenger?.phone && (
            <TouchableOpacity
              style={styles.callBtn}
              onPress={() => Linking.openURL(`tel:${passenger.phone}`)}
            >
              <Text style={styles.utilIcon}>📞</Text>
              <Text style={styles.callBtnText}>Call</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.chatBtn} onPress={handleChat}>
            <Text style={styles.utilIcon}>💬</Text>
            <Text style={styles.chatBtnText}>Chat</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.sosBtn} onPress={handleSOS}>
            <Text style={styles.utilIcon}>🆘</Text>
            <Text style={styles.sosBtnText}>SOS</Text>
          </TouchableOpacity>
        </View>

        {action && (
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: action.color }]}
            onPress={handleAction}
            disabled={actionLoading}
          >
            {actionLoading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.actionText}>{action.label}</Text>
            )}
          </TouchableOpacity>
        )}

        {/* Código de segurança para iniciar a viagem */}
        <Modal visible={pinModal} transparent animationType="fade" onRequestClose={() => setPinModal(false)}>
          <View style={styles.pinOverlay}>
            <View style={styles.pinCard}>
              <Text style={styles.pinTitle}>Código de segurança</Text>
              <Text style={styles.pinSub}>Pede os 4 dígitos à passageira para arrancar.</Text>
              <TextInput
                style={styles.pinInput}
                value={pin}
                onChangeText={(v) => setPin(v.replace(/\D/g, '').slice(0, 4))}
                keyboardType="number-pad"
                maxLength={4}
                placeholder="••••"
                autoFocus
              />
              <View style={styles.pinRow}>
                <TouchableOpacity style={styles.pinCancel} onPress={() => setPinModal(false)}>
                  <Text style={styles.pinCancelText}>Voltar</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.pinConfirm} onPress={confirmStart} disabled={actionLoading}>
                  {actionLoading ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.pinConfirmText}>Iniciar</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '50%',
    elevation: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
  },
  sheetContent: { padding: 20, paddingBottom: 32 },

  etaRow: {
    backgroundColor: '#1a1a2e',
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
  },
  etaLabel: { color: '#999', fontSize: 12 },
  etaValue: { color: '#FFD700', fontSize: 20, fontWeight: 'bold', marginTop: 2 },
  routeInfo: { color: '#FFD700', fontSize: 13, fontWeight: '700', marginTop: 6 },

  passengerCard: {
    backgroundColor: '#f8f8f8',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  passengerName: { fontSize: 17, fontWeight: 'bold', color: '#1a1a2e' },
  passengerPhone: { color: '#666', marginTop: 3 },

  addressBlock: {
    backgroundColor: '#f8f8f8',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  addressRow: { flexDirection: 'row', alignItems: 'flex-start' },
  addrIcon: { fontSize: 18, marginRight: 10, marginTop: 2 },
  addrTexts: { flex: 1 },
  addrLabel: { color: '#999', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
  addrValue: { color: '#1a1a2e', fontSize: 14, fontWeight: '500', marginTop: 2 },
  addrRef: {
    color: '#61188E', fontSize: 13, fontWeight: '700', marginTop: 4,
    backgroundColor: '#faf5ff', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8,
  },
  addressDivider: { height: 1, backgroundColor: '#e5e5e5', marginVertical: 10 },

  fareRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    marginBottom: 14,
  },
  fareLabel: { color: '#666', fontSize: 15 },
  fareValue: { fontSize: 20, fontWeight: 'bold', color: '#1a1a2e' },

  actionBtn: {
    borderRadius: 14,
    padding: 18,
    alignItems: 'center',
  },
  actionText: { color: '#1a1a2e', fontWeight: 'bold', fontSize: 17 },

  navigateBtn: {
    backgroundColor: '#2563eb',
    borderRadius: 14,
    padding: 15,
    alignItems: 'center',
    marginBottom: 12,
  },
  navigateText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },

  packageCard: {
    backgroundColor: '#FFF7E6',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#FFD700',
  },
  packageTitle: { fontSize: 11, fontWeight: '800', color: '#b45309', letterSpacing: 0.8 },
  packageDesc: { fontSize: 15, fontWeight: '700', color: '#1a1a2e', marginTop: 4 },
  packageReceiver: { fontSize: 13, color: '#666', marginTop: 4 },
  callReceiverBtn: {
    backgroundColor: '#dcfce7',
    borderRadius: 10,
    padding: 10,
    alignItems: 'center',
    marginTop: 10,
  },
  callReceiverText: { color: '#16a34a', fontWeight: '700', fontSize: 13 },

  utilRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  callBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: '#dcfce7',
    borderRadius: 12,
    padding: 12,
  },
  callBtnText: { color: '#16a34a', fontWeight: '700', fontSize: 13 },
  chatBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#f0f0f0',
    borderRadius: 12,
    padding: 12,
  },
  chatBtnText: { color: '#1a1a2e', fontWeight: '700', fontSize: 14 },
  sosBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#FEE2E2',
    borderRadius: 12,
    padding: 12,
  },
  sosBtnText: { color: '#ef4444', fontWeight: '700', fontSize: 14 },
  utilIcon: { fontSize: 16 },

  driverMarker: {
    width: 46,
    height: 46,
    backgroundColor: '#FFD700',
    borderRadius: 23,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  driverMarkerText: { fontSize: 26 },
  passengerMarker: {
    width: 38,
    height: 38,
    backgroundColor: '#1a1a2e',
    borderRadius: 19,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#fff',
  },
  passengerMarkerText: { fontSize: 22 },
  targetPin: {
    width: 38,
    height: 38,
    borderRadius: 19,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2.5,
    borderColor: '#fff',
    elevation: 5,
  },
  targetPinText: { fontSize: 18 },

  pinOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  pinCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 22,
    width: '100%',
  },
  pinTitle: { fontSize: 18, fontWeight: 'bold', color: '#1a1a2e', textAlign: 'center' },
  pinSub: { color: '#666', fontSize: 13, textAlign: 'center', marginTop: 6 },
  pinInput: {
    borderWidth: 1.5,
    borderColor: '#61188E',
    borderRadius: 14,
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: 8,
    textAlign: 'center',
    paddingVertical: 12,
    marginTop: 16,
    color: '#1a1a2e',
  },
  pinRow: { flexDirection: 'row', gap: 10, marginTop: 16 },
  pinCancel: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: '#e5e5e5',
    borderRadius: 14,
    padding: 14,
    alignItems: 'center',
  },
  pinCancelText: { color: '#666', fontWeight: '700', fontSize: 15 },
  pinConfirm: {
    flex: 1,
    backgroundColor: '#16a34a',
    borderRadius: 14,
    padding: 14,
    alignItems: 'center',
  },
  pinConfirmText: { color: '#fff', fontWeight: 'bold', fontSize: 15 },
});
