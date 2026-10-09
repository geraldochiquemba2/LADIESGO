import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Linking,
} from 'react-native';
import {
  Map as MapLibreMap,
  Camera,
  Marker,
  GeoJSONSource,
  Layer,
  type CameraRef,
} from '@maplibre/maplibre-react-native';
import { MAP_STYLE, fitCoordinates, lineBetween } from '../../components/appMap';
import MapAttribution from '../../components/MapAttribution';
import * as Location from 'expo-location';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '../../store';
import { socketService } from '../../services/socket';
import { cancelTrip, updateDriverLocation, updateTripStatus } from '../../store/slices/tripSlice';

const STATUS_LABELS: Record<string, string> = {
  ACCEPTED: 'Driver is on the way',
  DRIVER_ARRIVED: 'Driver has arrived! 🎉',
  IN_PROGRESS: 'Trip in progress',
  COMPLETED: 'Trip completed',
  CANCELLED: 'Trip cancelled',
};

export default function TrackDriverScreen({ navigation }: any) {
  const dispatch = useDispatch<AppDispatch>();
  const { currentTrip } = useSelector((s: RootState) => s.trip);
  const cameraRef = useRef<CameraRef>(null);

  const [myLocation, setMyLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [driverLocation, setDriverLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [driverHeading, setDriverHeading] = useState<number>(-1);
  const [eta, setEta] = useState<{ minutes: number; distanceKm: number } | null>(null);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [tripStatus, setTripStatus] = useState<string>(currentTrip?.status || 'ACCEPTED');
  const [liveFare, setLiveFare] = useState<{ fare: number; distanceKm: number; moving: boolean } | null>(null);

  const latestMyLoc = useRef<{ lat: number; lng: number } | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Live countdown — ticks down every second from latest ETA
  useEffect(() => {
    if (etaSeconds === null) return;
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      setEtaSeconds((s) => (s !== null && s > 0 ? s - 1 : 0));
    }, 1000);
    return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
  }, [Math.floor((etaSeconds ?? 0) / 60)]); // restart only when minute changes

  const fitMap = useCallback(
    (myLoc: { lat: number; lng: number }, driverLoc: { lat: number; lng: number }) => {
      fitCoordinates(
        cameraRef.current,
        [[myLoc.lng, myLoc.lat], [driverLoc.lng, driverLoc.lat]],
        { top: 80, right: 80, bottom: 300, left: 80 },
      );
    },
    [],
  );

  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;

    const setup = async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;

      await socketService.connect();

      // Stream passenger location in real time
      sub = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.High,
          timeInterval: 3000,
          distanceInterval: 15, // only fire when moved ≥ 15 m
        },
        (loc) => {
          const pos = { lat: loc.coords.latitude, lng: loc.coords.longitude };
          latestMyLoc.current = pos;
          setMyLocation(pos);
          socketService.emit('passenger:location-update', pos);
        },
      );

      // Receive driver's real-time location
      socketService.on('server:driver-location', (data) => {
        const dLoc = { lat: data.lat, lng: data.lng };
        setDriverLocation(dLoc);
        setDriverHeading(data.heading ?? -1);
        setEta({ minutes: data.etaMinutes, distanceKm: data.distanceKm });
        setEtaSeconds(data.etaMinutes * 60);
        dispatch(updateDriverLocation({ lat: data.lat, lng: data.lng }));
        if (data.status) setTripStatus(data.status);
        if (latestMyLoc.current) fitMap(latestMyLoc.current, dLoc);
      });

      // Live fare meter — only ticks when driver is moving
      socketService.on('server:fare-update', (data: { distanceKm: number; currentFare: number; moving: boolean }) => {
        setLiveFare({ fare: data.currentFare, distanceKm: data.distanceKm, moving: data.moving });
      });

      socketService.on('server:trip-update', (data) => {
        setTripStatus(data.status);
        dispatch(updateTripStatus({ status: data.status, finalFare: data.finalFare }));

        if (data.status === 'COMPLETED') {
          navigation.replace('TripComplete', { trip: { ...currentTrip, finalFare: data.finalFare } });
        }
        if (data.status === 'CANCELLED') {
          Alert.alert('Viagem cancelada', 'A viagem foi cancelada.', [
            { text: 'OK', onPress: () => navigation.replace('PassengerHome') },
          ]);
        }
      });
    };

    setup();

    return () => {
      sub?.remove();
      socketService.off('server:driver-location');
      socketService.off('server:fare-update');
      socketService.off('server:trip-update');
    };
  }, []);

  const handleCancel = () => {
    if (!currentTrip) return;
    Alert.alert('Cancelar viagem', 'Tens a certeza que queres cancelar?', [
      { text: 'No', style: 'cancel' },
      {
        text: 'Yes, Cancel',
        style: 'destructive',
        onPress: async () => {
          socketService.emit('passenger:cancel-trip', { tripId: currentTrip.id });
          await dispatch(cancelTrip({ id: currentTrip.id, reason: 'Cancelled by passenger' }));
          navigation.replace('PassengerHome');
        },
      },
    ]);
  };

  if (!myLocation) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#FFD700" />
        <Text style={styles.loadingText}>A obter a tua localização...</Text>
      </View>
    );
  }

  const driver = currentTrip?.driver;
  const isArrived = tripStatus === 'DRIVER_ARRIVED';

  const handleSOS = () => {
    Alert.alert('Emergência', 'Ligar para emergência em Angola?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Polícia 113', style: 'destructive', onPress: () => Linking.openURL('tel:113') },
      { text: 'Bombeiros 115', onPress: () => Linking.openURL('tel:115') },
    ]);
  };

  const handleChat = () => {
    if (!currentTrip) return;
    navigation.navigate('Chat', {
      tripId: currentTrip.id,
      otherName: driver?.user?.name || 'Motorista',
      otherUserId: driver?.userId || driver?.user?.id,
    });
  };
  const carRotation = driverHeading >= 0 ? driverHeading : 0;

  return (
    <View style={styles.container}>
      <MapLibreMap
        style={styles.map}
        mapStyle={MAP_STYLE}
        attribution={false}
        logo={false}
        compass={false}
      >
        <Camera
          ref={cameraRef}
          initialViewState={{ center: [myLocation.lng, myLocation.lat], zoom: 13 }}
        />
        {/* Passenger marker (me) */}
        <Marker
          lngLat={[myLocation.lng, myLocation.lat]}
          anchor="center"
        >
          <View style={styles.myMarker}>
            <Text style={styles.myMarkerText}>📍</Text>
          </View>
        </Marker>

        {/* Route line: my location → driver */}
        {driverLocation && (
          <GeoJSONSource
            id="driverRouteSource"
            data={lineBetween(
              [myLocation.lng, myLocation.lat],
              [driverLocation.lng, driverLocation.lat],
            )}
          >
            <Layer
              id="driverRouteLine"
              type="line"
              style={{ lineColor: '#FFD700', lineWidth: 3, lineDasharray: [2, 1.5] }}
            />
          </GeoJSONSource>
        )}

        {/* Driver marker — rotates with heading, updates in real time */}
        {driverLocation && (
          <Marker
            lngLat={[driverLocation.lng, driverLocation.lat]}
            anchor="center"
          >
            <View style={[
              styles.driverMarker,
              isArrived && styles.driverMarkerArrived,
              { transform: [{ rotate: `${carRotation}deg` }] },
            ]}>
              <Text style={styles.driverMarkerText}>🚗</Text>
            </View>
          </Marker>
        )}
      </MapLibreMap>
      <MapAttribution />

      {/* Bottom sheet */}
      <View style={styles.sheet}>
        {/* ETA banner */}
        <View style={[styles.etaBanner, isArrived && styles.etaBannerArrived]}>
          {eta ? (
            <View style={styles.etaInner}>
              <Text style={styles.etaMinutes}>
                {etaSeconds !== null
                  ? `${Math.floor(etaSeconds / 60)}:${String(etaSeconds % 60).padStart(2, '0')}`
                  : `${eta.minutes} min`}
              </Text>
              <Text style={styles.etaDot}>·</Text>
              <Text style={styles.etaDist}>{eta.distanceKm} km away</Text>
            </View>
          ) : (
            <View style={styles.etaInner}>
              <ActivityIndicator color="#FFD700" size="small" />
              <Text style={styles.etaDist}>  Connecting to driver...</Text>
            </View>
          )}
        </View>

        {/* Live fare meter — only shows during IN_PROGRESS, pauses when driver stops */}
        {tripStatus === 'IN_PROGRESS' && liveFare && (
          <View style={[styles.fareMeter, !liveFare.moving && styles.fareMeterPaused]}>
            <View style={styles.fareMeterLeft}>
              <Text style={styles.fareMeterLabel}>
                {liveFare.moving ? '📍 Meter running' : '⏸ Meter paused'}
              </Text>
              <Text style={styles.fareMeterDist}>{liveFare.distanceKm} km driven</Text>
            </View>
            <Text style={styles.fareMeterFare}>{liveFare.fare.toFixed(2)} SAR</Text>
          </View>
        )}

        {/* Status */}
        <Text style={styles.statusText}>{STATUS_LABELS[tripStatus] || tripStatus}</Text>

        {/* Código de segurança — dita à motorista para arrancar */}
        {(currentTrip as any)?.pin && (tripStatus === 'ACCEPTED' || tripStatus === 'DRIVER_ARRIVED') && (
          <View style={styles.pinCard}>
            <View style={styles.pinLeft}>
              <Text style={styles.pinLabel}>Código de segurança</Text>
              <Text style={styles.pinSub}>Partilha só ao entrar</Text>
            </View>
            <Text style={styles.pinValue}>{String((currentTrip as any).pin)}</Text>
          </View>
        )}

        {/* Driver info card */}
        {driver && (
          <View style={styles.driverCard}>
            <View style={styles.driverInfo}>
              <Text style={styles.driverName}>{driver.user?.name || 'Your Driver'}</Text>
              <Text style={styles.driverSub}>
                {[driver.carMake, driver.carModel, driver.carColor].filter(Boolean).join(' · ')}
              </Text>
              <Text style={styles.driverPlate}>{driver.carPlate}</Text>
            </View>
            <View style={styles.ratingBadge}>
              <Text style={styles.ratingText}>⭐</Text>
              <Text style={styles.ratingValue}>{Number(driver.rating ?? 5).toFixed(1)}</Text>
            </View>
          </View>
        )}

        {/* Action row: Call + Chat + SOS */}
        <View style={styles.actionRow}>
          {driver?.user?.phone && (
            <TouchableOpacity
              style={styles.callBtn}
              onPress={() => Linking.openURL(`tel:${driver.user.phone}`)}
            >
              <Text style={styles.callBtnIcon}>📞</Text>
              <Text style={styles.callBtnText}>Call</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.chatBtn} onPress={handleChat}>
            <Text style={styles.chatBtnIcon}>💬</Text>
            <Text style={styles.chatBtnText}>Chat</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.sosBtn} onPress={handleSOS}>
            <Text style={styles.sosBtnIcon}>🆘</Text>
            <Text style={styles.sosBtnText}>SOS</Text>
          </TouchableOpacity>
        </View>

        {tripStatus === 'ACCEPTED' && (
          <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel}>
            <Text style={styles.cancelText}>Cancelar viagem</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  loadingText: { marginTop: 16, color: '#666', fontSize: 15 },

  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    paddingBottom: 32,
    elevation: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
  },

  etaBanner: {
    backgroundColor: '#1a1a2e',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 20,
    marginBottom: 14,
  },
  etaBannerArrived: { backgroundColor: '#16a34a' },
  etaInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  etaMinutes: { color: '#FFD700', fontSize: 24, fontWeight: 'bold' },
  etaDot: { color: '#555', fontSize: 22, marginHorizontal: 8 },
  etaDist: { color: '#aaa', fontSize: 16 },

  statusText: {
    fontSize: 17,
    fontWeight: '600',
    color: '#333',
    textAlign: 'center',
    marginBottom: 14,
  },

  driverCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8f8f8',
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
  },
  driverInfo: { flex: 1 },
  pinCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f6f4fa',
    borderWidth: 1.5,
    borderColor: '#c4b5fd',
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
  },
  pinLeft: { flex: 1 },
  pinLabel: { fontSize: 15, fontWeight: '700', color: '#1a1a2e' },
  pinSub: { color: '#666', fontSize: 12, marginTop: 2 },
  pinValue: {
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: 4,
    color: '#61188E',
    backgroundColor: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    overflow: 'hidden',
  },
  driverName: { fontSize: 17, fontWeight: 'bold', color: '#1a1a2e' },
  driverSub: { color: '#666', marginTop: 2, fontSize: 13 },
  driverPlate: {
    color: '#1a1a2e',
    fontWeight: '700',
    marginTop: 6,
    fontSize: 16,
    letterSpacing: 1.5,
    backgroundColor: '#FFD700',
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 6,
  },
  ratingBadge: { alignItems: 'center', paddingLeft: 12 },
  ratingText: { fontSize: 20 },
  ratingValue: { fontSize: 16, fontWeight: 'bold', color: '#1a1a2e', marginTop: 2 },

  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  callBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: '#dcfce7',
    borderRadius: 14,
    padding: 14,
  },
  callBtnIcon: { fontSize: 16 },
  callBtnText: { color: '#16a34a', fontWeight: '700', fontSize: 14 },
  chatBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#f0f0f0',
    borderRadius: 14,
    padding: 14,
  },
  chatBtnIcon: { fontSize: 18 },
  chatBtnText: { color: '#1a1a2e', fontWeight: '700', fontSize: 15 },
  sosBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#FEE2E2',
    borderRadius: 14,
    padding: 14,
  },
  sosBtnIcon: { fontSize: 18 },
  sosBtnText: { color: '#ef4444', fontWeight: '700', fontSize: 15 },

  cancelBtn: {
    borderWidth: 1.5,
    borderColor: '#ef4444',
    borderRadius: 14,
    padding: 14,
    alignItems: 'center',
  },
  cancelText: { color: '#ef4444', fontWeight: 'bold', fontSize: 16 },

  fareMeter: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#1a1a2e', borderRadius: 14, padding: 14, marginBottom: 10,
  },
  fareMeterPaused: { backgroundColor: '#f59e0b' },
  fareMeterLeft: { flex: 1 },
  fareMeterLabel: { color: '#FFD700', fontSize: 12, fontWeight: '700' },
  fareMeterDist: { color: '#aaa', fontSize: 11, marginTop: 2 },
  fareMeterFare: { color: '#fff', fontSize: 24, fontWeight: '900' },

  myMarker: {
    width: 38,
    height: 38,
    backgroundColor: '#1a1a2e',
    borderRadius: 19,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#fff',
  },
  myMarkerText: { fontSize: 20 },
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
  driverMarkerArrived: { backgroundColor: '#16a34a' },
  driverMarkerText: { fontSize: 26 },
});
