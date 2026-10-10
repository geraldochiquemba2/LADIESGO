import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  Switch,
  StyleSheet,
  Alert,
  TouchableOpacity,
  Modal,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import {
  Map as MapLibreMap,
  Camera,
  Marker,
  type CameraRef,
} from '@maplibre/maplibre-react-native';
import { MAP_STYLE } from '../../components/appMap';
import MapAttribution from '../../components/MapAttribution';
import * as Location from 'expo-location';
import { startDriverBgTracking, stopDriverBgTracking, ensureDriverBgTracking } from '../../services/driverBgLocation';
import { driversApi, tripsApi } from '../../services/api';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { socketService } from '../../services/socket';

const { height } = Dimensions.get('window');

export default function DriverHomeScreen({ navigation }: any) {
  const { user } = useSelector((s: RootState) => s.auth);
  const [isOnline, setIsOnline] = useState(false);
  const [location, setLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [heading, setHeading] = useState<number>(-1);
  const [earnings, setEarnings] = useState(0);
  const [tripRequest, setTripRequest] = useState<any>(null);
  const [accepting, setAccepting] = useState(false);
  const [liveRequests, setLiveRequests] = useState<Map<string, { id: string; pickupLat: number; pickupLng: number; fareEstimate?: number }>>(new Map());
  const cameraRef = useRef<CameraRef>(null);
  const locationSubRef = useRef<Location.LocationSubscription | null>(null);

  // Initial setup: get location + load driver status
  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      const loc = await Location.getCurrentPositionAsync({});
      setLocation({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });

      try {
        const driver = await driversApi.getStatus();
        setIsOnline(driver.data.isOnline);
        setEarnings(driver.data.totalEarnings);
        // Se já estava online (app reaberta), retomar tracking em fundo sem chatear
        if (driver.data.isOnline) ensureDriverBgTracking().catch(() => {});
      } catch {
        // driver not registered yet
      }
    })();
  }, []);

  // Real-time location stream while online (idle: adaptativo 10s/20m).
  // Fundo (driverBgLocation) trata do Waze aberto; aqui trata da app aberta.
  useEffect(() => {
    if (!isOnline) {
      locationSubRef.current?.remove();
      locationSubRef.current = null;
      return;
    }

    let lastRestTs = 0;
    const startWatching = async () => {
      locationSubRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 5000,
          distanceInterval: 20,
        },
        (loc) => {
          const pos = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
          const h = loc.coords.heading ?? -1;
          setLocation(pos);
          setHeading(h);
          socketService.emit('driver:location-update', {
            lat: pos.latitude,
            lng: pos.longitude,
            heading: h,
          });
          // REST throttled 10s (Cloudflare Workers: sem socket, o polling usa isto).
          const now = Date.now();
          if (now - lastRestTs >= 10000) {
            lastRestTs = now;
            driversApi.updateLocation(pos.latitude, pos.longitude).catch(() => {});
          }
          // Smoothly follow driver on map
          cameraRef.current?.easeTo({
            center: [pos.longitude, pos.latitude],
            zoom: 15,
            duration: 400,
          });
        },
      );
    };

    startWatching();

    return () => {
      locationSubRef.current?.remove();
      locationSubRef.current = null;
    };
  }, [isOnline]);

  // Socket: listen for trip requests when online
  useEffect(() => {
    if (!isOnline) {
      socketService.off('server:new-trip-request');
      return;
    }

    socketService.connect().then(() => {
      socketService.on('server:new-trip-request', (data) => {
        setTripRequest(data);
      });

      // Show pending requests as hotspot pins on map
      socketService.emit('join:public-requests', {});
      socketService.on('public:requests-snapshot', (list: any[]) => {
        setLiveRequests(() => {
          const m = new Map();
          list.forEach((r) => m.set(r.id, r));
          return m;
        });
      });
      socketService.on('public:trip-requested', (r: any) => {
        setLiveRequests((prev) => new Map(prev).set(r.id, r));
      });
      socketService.on('public:trip-removed', (d: { id: string }) => {
        setLiveRequests((prev) => { const n = new Map(prev); n.delete(d.id); return n; });
      });
    }).catch(() => {
      Alert.alert('Connection', 'Could not connect to server. Check your internet.');
    });

    return () => {
      socketService.off('server:new-trip-request');
      socketService.off('public:requests-snapshot');
      socketService.off('public:trip-requested');
      socketService.off('public:trip-removed');
    };
  }, [isOnline]);

  const handleToggleOnline = async (value: boolean) => {
    try {
      await driversApi.toggleOnline(value);
      setIsOnline(value);
      if (value) {
        // Fundo: continua a partilhar posição mesmo com o Waze aberto
        try {
          await startDriverBgTracking();
        } catch (e: any) {
          const m = e?.message;
          if (m === 'precise-denied') {
            Alert.alert(
              'Localização exata',
              'Ativa a "Localização exata" para o LadiesGo nas definições do iPhone (Privacidade > Localização). Sem isso a posição não chega.',
            );
          } else if (m === 'background-denied') {
            Alert.alert(
              'Localização em fundo',
              'Para continuares online com outra app aberta, permite a posição "Sempre" nas definições do telemóvel.',
            );
          } else if (m !== 'foreground-denied') {
            Alert.alert(
              'Localização em fundo',
              'Não foi possível ligar o tracking em fundo. Com outra app aberta, volta aqui para atualizares a posição.',
            );
          }
        }
      } else {
        setTripRequest(null);
        await stopDriverBgTracking();
      }
    } catch (e: any) {
      Alert.alert('Error', e.response?.data?.message || 'Cannot change status');
    }
  };

  const handleAcceptTrip = async () => {
    if (!tripRequest?.trip?.id) return;
    setAccepting(true);
    try {
      await tripsApi.accept(tripRequest.trip.id);
      socketService.emit('driver:trip-accepted', { tripId: tripRequest.trip.id });
      const acceptedTrip = {
        ...tripRequest.trip,
        status: 'ACCEPTED',
        passenger: tripRequest.passenger,
      };
      setTripRequest(null);
      navigation.navigate('ActiveTrip', { trip: acceptedTrip });
    } catch (e: any) {
      Alert.alert('Error', e.response?.data?.message || 'Could not accept trip');
      setTripRequest(null);
    } finally {
      setAccepting(false);
    }
  };

  const handleDeclineTrip = () => setTripRequest(null);

  const recenterMap = () => {
    if (!location) return;
    cameraRef.current?.easeTo({
      center: [location.longitude, location.latitude],
      zoom: 15,
      duration: 600,
    });
  };

  // Tap a red booking point on the map → open it in the accept modal
  const handleTapRequest = async (requestId: string) => {
    try {
      const res = await tripsApi.getTrip(requestId);
      const t = res.data;
      if (t.status !== 'REQUESTED') {
        Alert.alert('Taken', 'This booking was already taken by another driver.');
        setLiveRequests((prev) => { const n = new Map(prev); n.delete(requestId); return n; });
        return;
      }
      setTripRequest({ trip: t, passenger: t.passenger });
    } catch {
      Alert.alert('Error', 'Could not load this booking. Try again.');
    }
  };

  return (
    <View style={styles.container}>
      {location && (
        <MapLibreMap
          style={styles.map}
          mapStyle={MAP_STYLE}
          attribution={false}
          logo={false}
          compass={false}
        >
          <Camera
            ref={cameraRef}
            initialViewState={{ center: [location.longitude, location.latitude], zoom: 15 }}
          />
          <Marker
            lngLat={[location.longitude, location.latitude]}
            anchor="center"
          >
            <View style={[
              styles.selfMarker,
              heading >= 0 && { transform: [{ rotate: `${heading}deg` }] },
            ]}>
              <Text style={styles.selfMarkerText}>🚗</Text>
            </View>
          </Marker>

          {/* Live booking points — tap a red point to accept that booking */}
          {Array.from(liveRequests.values()).map((r: any) => (
            <Marker
              key={r.id}
              lngLat={[r.pickupLng, r.pickupLat]}
              anchor="center"
              onPress={() => handleTapRequest(r.id)}
            >
              <View style={styles.requestPin}>
                <View style={styles.redPoint}>
                  <Text style={styles.redPointIcon}>{r.tripType === 'DELIVERY' ? '📦' : '🙋'}</Text>
                </View>
                {r.fareEstimate ? (
                  <View style={styles.requestFareBubble}>
                    <Text style={styles.requestFareText}>{r.fareEstimate} SAR</Text>
                  </View>
                ) : null}
              </View>
            </Marker>
          ))}
        </MapLibreMap>
      )}
      <MapAttribution />

      {/* Recenter to my location */}
      <View style={styles.mapControls}>
        <TouchableOpacity style={styles.mapCtrlBtn} onPress={recenterMap}>
          <Text style={styles.mapCtrlIcon}>◎</Text>
        </TouchableOpacity>
      </View>

      {/* Status panel */}
      <View style={styles.panel}>
        <View style={styles.statusRow}>
          <View>
            <Text style={styles.name}>{user?.name || 'Driver'}</Text>
            <Text style={[styles.status, isOnline && styles.statusOnline]}>
              {isOnline ? '🟢 Online — waiting for trips' : '🔴 Offline'}
            </Text>
          </View>
          <Switch
            value={isOnline}
            onValueChange={handleToggleOnline}
            trackColor={{ false: '#ddd', true: '#16a34a' }}
            thumbColor={isOnline ? '#fff' : '#fff'}
          />
        </View>

        {/* Earnings row */}
        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{earnings.toFixed(0)} SAR</Text>
            <Text style={styles.statLabel}>Total Earned</Text>
          </View>
          <View style={[styles.statCard, styles.statCardHighlight]}>
            <Text style={[styles.statValue, { color: '#FFD700' }]}>80%</Text>
            <Text style={[styles.statLabel, { color: '#aaa' }]}>Your cut</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{isOnline ? '🟢' : '🔴'}</Text>
            <Text style={styles.statLabel}>{isOnline ? 'Active' : 'Offline'}</Text>
          </View>
        </View>

        {/* Earnings potential hint */}
        {!isOnline && (
          <View style={styles.earnHint}>
            <Text style={styles.earnHintText}>💡 Drivers earn avg 150–400 SAR/day. Go online to start!</Text>
          </View>
        )}

        <View style={styles.quickActions}>
          <TouchableOpacity style={styles.quickBtn} onPress={() => navigation.navigate('DriverEarnings')}>
            <Text style={styles.quickBtnIcon}>💰</Text>
            <Text style={styles.quickBtnText}>Earnings</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.quickBtn} onPress={() => navigation.navigate('Notifications')}>
            <Text style={styles.quickBtnIcon}>🔔</Text>
            <Text style={styles.quickBtnText}>Alerts</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.quickBtn} onPress={() => navigation.navigate('Profile')}>
            <Text style={styles.quickBtnIcon}>👤</Text>
            <Text style={styles.quickBtnText}>Profile</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Trip request modal */}
      <Modal visible={!!tripRequest} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {tripRequest?.trip?.tripType === 'DELIVERY' ? '📦 PACKAGE DELIVERY' : '🚖 New Trip Request'}
            </Text>

            {tripRequest?.trip?.tripType === 'DELIVERY' && (
              <View style={styles.packageCard}>
                <Text style={styles.packageDesc}>📦 {tripRequest?.trip?.packageDescription || 'Package'}</Text>
                {tripRequest?.trip?.receiverName ? (
                  <Text style={styles.packageReceiver}>
                    Deliver to: {tripRequest.trip.receiverName}
                    {tripRequest?.trip?.receiverPhone ? ` · ${tripRequest.trip.receiverPhone}` : ''}
                  </Text>
                ) : null}
              </View>
            )}

            <View style={styles.passengerRow}>
              <Text style={styles.passengerAvatar}>👤</Text>
              <Text style={styles.passengerName}>
                {tripRequest?.passenger?.name || 'Passenger'}
              </Text>
            </View>

            <View style={styles.addressBlock}>
              <View style={styles.addrRow}>
                <Text style={styles.addrIcon}>📍</Text>
                <View style={styles.addrTexts}>
                  <Text style={styles.addrLabel}>Pickup</Text>
                  <Text style={styles.addrValue} numberOfLines={2}>
                    {tripRequest?.trip?.pickupAddress}
                  </Text>
                  {tripRequest?.trip?.pickupRef ? (
                    <Text style={styles.addrRef} numberOfLines={2}>
                      🏢 {tripRequest.trip.pickupRef}
                    </Text>
                  ) : null}
                </View>
              </View>
              <View style={styles.addrDivider} />
              <View style={styles.addrRow}>
                <Text style={styles.addrIcon}>🏁</Text>
                <View style={styles.addrTexts}>
                  <Text style={styles.addrLabel}>Dropoff</Text>
                  <Text style={styles.addrValue} numberOfLines={2}>
                    {tripRequest?.trip?.dropoffAddress}
                  </Text>
                  {tripRequest?.trip?.dropoffRef ? (
                    <Text style={styles.addrRef} numberOfLines={2}>
                      🏢 {tripRequest.trip.dropoffRef}
                    </Text>
                  ) : null}
                </View>
              </View>
            </View>

            {/* Scheduled badge */}
            {tripRequest?.trip?.scheduledAt && (
              <View style={styles.scheduledBadge}>
                <Text style={styles.scheduledIcon}>🗓️</Text>
                <Text style={styles.scheduledText}>
                  Scheduled: {new Date(tripRequest.trip.scheduledAt).toLocaleString('pt-PT', {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                  })}
                </Text>
              </View>
            )}

            <View style={styles.fareRow}>
              <View style={styles.fareItem}>
                <Text style={styles.fareLabel}>Fare</Text>
                <Text style={styles.fareValue}>{tripRequest?.trip?.fareEstimate} SAR</Text>
              </View>
              <View style={styles.fareItem}>
                <Text style={styles.fareLabel}>Type</Text>
                <Text style={styles.fareValue}>
                  {tripRequest?.trip?.tripType === 'DELIVERY' ? '📦 Delivery' : (tripRequest?.trip?.rideType ?? 'ECONOMY')}
                </Text>
              </View>
              <View style={styles.fareItem}>
                <Text style={styles.fareLabel}>Payment</Text>
                <Text style={styles.fareValue}>
                  {tripRequest?.trip?.paymentMethod === 'CASH' ? '💵 Cash' : '💳 Card'}
                </Text>
              </View>
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.declineBtn} onPress={handleDeclineTrip}>
                <Text style={styles.declineText}>Decline</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.acceptBtn}
                onPress={handleAcceptTrip}
                disabled={accepting}
              >
                {accepting ? (
                  <ActivityIndicator color="#1a1a2e" />
                ) : (
                  <Text style={styles.acceptText}>
                    {tripRequest?.trip?.tripType === 'DELIVERY' ? 'Accept Delivery' : 'Accept Trip'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },

  selfMarker: {
    width: 44,
    height: 44,
    backgroundColor: '#FFD700',
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
  },
  selfMarkerText: { fontSize: 24 },

  mapControls: {
    position: 'absolute', right: 14, bottom: height * 0.37,
  },
  mapCtrlBtn: {
    width: 44, height: 44, backgroundColor: '#fff', borderRadius: 22,
    justifyContent: 'center', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 6, elevation: 6,
  },
  mapCtrlIcon: { fontSize: 20, color: '#1a1a2e' },

  requestPin: { alignItems: 'center' },
  redPoint: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: '#ef4444',
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2.5, borderColor: '#fff',
    elevation: 5, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4,
  },
  redPointIcon: { fontSize: 16 },
  requestFareBubble: {
    backgroundColor: '#ef4444', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2, marginTop: 2,
  },
  requestFareText: { color: '#fff', fontSize: 10, fontWeight: '800' },

  panel: {
    backgroundColor: '#fff',
    padding: 20,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  name: { fontSize: 18, fontWeight: 'bold', color: '#1a1a2e' },
  status: { color: '#999', marginTop: 4, fontSize: 13 },
  statusOnline: { color: '#16a34a' },

  statsRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  statCard: {
    flex: 1, backgroundColor: '#f8f8f8', borderRadius: 14, padding: 12, alignItems: 'center', gap: 4,
  },
  statCardHighlight: { backgroundColor: '#1a1a2e' },
  statValue: { fontSize: 18, fontWeight: '800', color: '#1a1a2e' },
  statLabel: { color: '#888', fontSize: 11, fontWeight: '600' },

  earnHint: {
    backgroundColor: '#FFFDE7', borderRadius: 12, padding: 12, marginBottom: 12,
    borderWidth: 1, borderColor: '#FFD700',
  },
  earnHintText: { color: '#1a1a2e', fontSize: 13, fontWeight: '500' },

  quickActions: { flexDirection: 'row', gap: 10 },
  quickBtn: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: '#f8f8f8',
    borderRadius: 14,
    padding: 14,
    gap: 4,
  },
  quickBtnIcon: { fontSize: 24 },
  quickBtnText: { color: '#1a1a2e', fontWeight: '600', fontSize: 13 },

  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 36,
  },
  modalTitle: { fontSize: 20, fontWeight: 'bold', color: '#1a1a2e', marginBottom: 16 },
  packageCard: {
    backgroundColor: '#FFF7E6', borderRadius: 12, padding: 12, marginBottom: 12,
    borderWidth: 1, borderColor: '#FFD700',
  },
  packageDesc: { fontSize: 15, fontWeight: '700', color: '#1a1a2e' },
  packageReceiver: { fontSize: 13, color: '#666', marginTop: 4 },

  passengerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8f8f8',
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
  },
  passengerAvatar: { fontSize: 28, marginRight: 12 },
  passengerName: { fontSize: 17, fontWeight: '600', color: '#1a1a2e' },

  addressBlock: {
    backgroundColor: '#f8f8f8',
    borderRadius: 12,
    padding: 14,
    marginBottom: 14,
  },
  addrRow: { flexDirection: 'row', alignItems: 'flex-start' },
  addrIcon: { fontSize: 18, marginRight: 10, marginTop: 2 },
  addrTexts: { flex: 1 },
  addrLabel: { color: '#999', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
  addrValue: { color: '#1a1a2e', fontSize: 14, fontWeight: '500', marginTop: 2 },
  addrRef: {
    color: '#61188E', fontSize: 13, fontWeight: '700', marginTop: 4,
    backgroundColor: '#faf5ff', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8,
  },
  addrDivider: { height: 1, backgroundColor: '#e5e5e5', marginVertical: 10 },

  fareRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#f8f8f8',
    borderRadius: 12,
    padding: 14,
    marginBottom: 20,
  },
  fareItem: { alignItems: 'center' },
  fareLabel: { color: '#999', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
  fareValue: { color: '#1a1a2e', fontSize: 16, fontWeight: 'bold', marginTop: 4 },

  scheduledBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#dbeafe', borderRadius: 10, padding: 10, marginBottom: 12,
    borderWidth: 1, borderColor: '#93c5fd',
  },
  scheduledIcon: { fontSize: 16 },
  scheduledText: { color: '#1d4ed8', fontWeight: '600', fontSize: 13 },

  modalActions: { flexDirection: 'row', gap: 12 },
  declineBtn: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: '#ef4444',
    borderRadius: 14,
    padding: 16,
    alignItems: 'center',
  },
  declineText: { color: '#ef4444', fontWeight: 'bold', fontSize: 16 },
  acceptBtn: {
    flex: 2,
    backgroundColor: '#FFD700',
    borderRadius: 14,
    padding: 16,
    alignItems: 'center',
  },
  acceptText: { color: '#1a1a2e', fontWeight: 'bold', fontSize: 16 },
});
