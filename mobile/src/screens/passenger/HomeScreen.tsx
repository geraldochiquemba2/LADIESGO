import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  Platform,
  StatusBar,
  Modal,
  Linking,
} from 'react-native';
import {
  Map as MapLibreMap,
  Camera,
  Marker,
  UserLocation,
  type CameraRef,
} from '@maplibre/maplibre-react-native';
import { MAP_STYLE } from '../../components/appMap';
import MapAttribution from '../../components/MapAttribution';
import * as Location from 'expo-location';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '../../store';
import { driversApi, notificationsApi } from '../../services/api';
import { setNearbyDrivers } from '../../store/slices/tripSlice';
import { socketService } from '../../services/socket';

const { height } = Dimensions.get('window');

interface LiveDriver {
  id: string;
  currentLat: number;
  currentLng: number;
  heading?: number;
  name?: string;
  phone?: string;
  vehicleModel?: string;
  vehiclePlate?: string;
  rating?: number;
}

interface TripRequest {
  id: string;
  pickupLat: number;
  pickupLng: number;
  pickupAddress?: string;
  fareEstimate?: number;
  rideType?: string;
}

export default function PassengerHomeScreen({ navigation }: any) {
  const dispatch = useDispatch<AppDispatch>();
  const { user } = useSelector((s: RootState) => s.auth);
  const [location, setLocation] = useState<any>(null);
  const [liveDrivers, setLiveDrivers] = useState<Map<string, LiveDriver>>(new Map());
  const [liveRequests, setLiveRequests] = useState<Map<string, TripRequest>>(new Map());
  const [unreadCount, setUnreadCount] = useState(0);
  const [activeTab, setActiveTab] = useState<'ride' | 'deliver'>('ride');
  const [selectedDriver, setSelectedDriver] = useState<LiveDriver | null>(null);
  const cameraRef = useRef<CameraRef>(null);

  // Get location and center map
  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setLocation(loc.coords);
      cameraRef.current?.easeTo({
        center: [loc.coords.longitude, loc.coords.latitude],
        zoom: 12, // city-level zoom
        duration: 800,
      });
    })();
  }, []);

  // Live drivers + trip requests via WebSocket
  useEffect(() => {
    socketService.connect().then(async () => {
      // ── Drivers ──────────────────────────────────────────────────
      socketService.emit('join:public-drivers', {});

      // Try REST for initial drivers list with phone/name/vehicle
      try {
        const res = await driversApi.getNearby(
          location?.latitude ?? 24.7136,
          location?.longitude ?? 46.6753,
        );
        const initial: LiveDriver[] = (res.data ?? []).filter(
          (d: any) => d.currentLat && d.currentLng,
        );
        setLiveDrivers((prev) => {
          const next = new Map(prev);
          initial.forEach((d) => next.set(d.id, d));
          return next;
        });
        dispatch(setNearbyDrivers(res.data ?? []));
      } catch {}

      // WebSocket position updates — adds new drivers too
      socketService.on('public:driver-location', (data: { driverId: string; lat: number; lng: number; heading: number }) => {
        setLiveDrivers((prev) => {
          const next = new Map(prev);
          const existing = next.get(data.driverId) ?? { id: data.driverId, currentLat: data.lat, currentLng: data.lng };
          next.set(data.driverId, { ...existing, currentLat: data.lat, currentLng: data.lng, heading: data.heading });
          return next;
        });
      });

      // ── Pending trip requests ────────────────────────────────────
      socketService.emit('join:public-requests', {});

      socketService.on('public:requests-snapshot', (list: TripRequest[]) => {
        setLiveRequests(() => {
          const m = new Map<string, TripRequest>();
          list.forEach((r) => m.set(r.id, r));
          return m;
        });
      });

      socketService.on('public:trip-requested', (req: TripRequest) => {
        setLiveRequests((prev) => new Map(prev).set(req.id, req));
      });

      socketService.on('public:trip-removed', (data: { id: string }) => {
        setLiveRequests((prev) => {
          const next = new Map(prev);
          next.delete(data.id);
          return next;
        });
      });
    }).catch(() => {});

    // Fallback REST refresh every 60s
    const id = setInterval(async () => {
      if (!location) return;
      try {
        const res = await driversApi.getNearby(location.latitude, location.longitude);
        dispatch(setNearbyDrivers(res.data ?? []));
      } catch {}
    }, 60000);

    return () => {
      clearInterval(id);
      socketService.off('public:driver-location');
      socketService.off('public:requests-snapshot');
      socketService.off('public:trip-requested');
      socketService.off('public:trip-removed');
    };
  }, [location]);

  // Notification badge
  useEffect(() => {
    notificationsApi.getUnreadCount().then((r) => setUnreadCount(r.data.count)).catch(() => {});
    const id = setInterval(() => {
      notificationsApi.getUnreadCount().then((r) => setUnreadCount(r.data.count)).catch(() => {});
    }, 30000);
    return () => clearInterval(id);
  }, []);

  const recenterMap = () => {
    if (!location) return;
    cameraRef.current?.easeTo({
      center: [location.longitude, location.latitude],
      zoom: 12,
      duration: 600,
    });
  };

  const zoomToCity = () => {
    const lat = location?.latitude ?? 24.7136;
    const lng = location?.longitude ?? 46.6753;
    cameraRef.current?.easeTo({ center: [lng, lat], zoom: 9.5, duration: 600 });
  };

  const driverCount = liveDrivers.size;
  const requestCount = liveRequests.size;

  return (
    <View style={styles.container}>
      <StatusBar translucent backgroundColor="transparent" barStyle="dark-content" />

      {/* Full-screen map */}
      <MapLibreMap
        style={styles.map}
        mapStyle={MAP_STYLE}
        attribution={false}
        logo={false}
        compass={false}
      >
        <Camera
          ref={cameraRef}
          initialViewState={
            location
              ? { center: [location.longitude, location.latitude], zoom: 12 }
              : { center: [46.6753, 24.7136], zoom: 9.5 }
          }
        />
        <UserLocation />
        {/* Live driver pins */}
        {Array.from(liveDrivers.values()).map((d) => (
          <Marker
            key={d.id}
            lngLat={[d.currentLng, d.currentLat]}
            anchor="center"
            onPress={() => setSelectedDriver(d)}
          >
            <View style={styles.carPin}>
              <Text style={styles.carPinText}>🚗</Text>
            </View>
          </Marker>
        ))}

        {/* Pending trip request pins */}
        {Array.from(liveRequests.values()).map((r) => (
          <Marker
            key={r.id}
            lngLat={[r.pickupLng, r.pickupLat]}
            anchor="bottom"
          >
            <View style={styles.requestPin}>
              <View style={styles.redPoint}>
                <Text style={styles.redPointIcon}>{(r as any).tripType === 'DELIVERY' ? '📦' : '🙋'}</Text>
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
      <MapAttribution />

      {/* Top bar — floating */}
      <View style={styles.topBar}>
        <TouchableOpacity style={styles.menuBtn} onPress={() => navigation.navigate('Profile')}>
          <Text style={styles.menuBtnText}>☰</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.searchBar}
          onPress={() => navigation.navigate('BookRide', { location, mode: activeTab })}
          activeOpacity={0.9}
        >
          <Text style={styles.searchIcon}>🔍</Text>
          <Text style={styles.searchText}>
            {activeTab === 'ride' ? 'Where to?' : 'Where to deliver?'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.bellBtn} onPress={() => navigation.navigate('Notifications')}>
          <Text style={styles.bellText}>🔔</Text>
          {unreadCount > 0 && (
            <View style={styles.badge}><Text style={styles.badgeText}>{unreadCount > 9 ? '9+' : unreadCount}</Text></View>
          )}
        </TouchableOpacity>
      </View>

      {/* Live status pill */}
      <View style={styles.liveStatusRow}>
        {driverCount > 0 && (
          <View style={styles.liveStatusPill}>
            <View style={styles.liveDot} />
            <Text style={styles.liveStatusText}>🚗 {driverCount} online</Text>
          </View>
        )}
        {requestCount > 0 && (
          <View style={[styles.liveStatusPill, styles.liveStatusPillRequest]}>
            <View style={[styles.liveDot, styles.liveDotRequest]} />
            <Text style={styles.liveStatusText}>🙋 {requestCount} waiting</Text>
          </View>
        )}
      </View>

      {/* Map controls */}
      <View style={styles.mapControls}>
        <TouchableOpacity style={styles.mapCtrlBtn} onPress={recenterMap}>
          <Text style={styles.mapCtrlIcon}>◎</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.mapCtrlBtn} onPress={zoomToCity}>
          <Text style={styles.mapCtrlIcon}>🗺</Text>
        </TouchableOpacity>
      </View>

      {/* Bottom card */}
      <View style={styles.bottomCard}>
        <View style={styles.tabs}>
          {(['ride', 'deliver'] as const).map((t) => (
            <TouchableOpacity
              key={t}
              style={[styles.tab, activeTab === t && styles.tabActive]}
              onPress={() => setActiveTab(t)}
            >
              <Text style={styles.tabIcon}>{t === 'ride' ? '🚗' : '📦'}</Text>
              <Text style={[styles.tabText, activeTab === t && styles.tabTextActive]}>
                {t === 'ride' ? 'Ride' : 'Deliver'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity
          style={styles.ctaBtn}
          onPress={() => navigation.navigate('BookRide', { location, mode: activeTab })}
          activeOpacity={0.88}
        >
          <Text style={styles.ctaText}>
            {activeTab === 'ride' ? '🚗  Pedir viagem' : '📦  Enviar encomenda'}
          </Text>
        </TouchableOpacity>

        <View style={styles.quickRow}>
          <TouchableOpacity style={styles.quickItem} onPress={() => navigation.navigate('TripHistory')}>
            <View style={styles.quickIcon}><Text style={styles.quickIconText}>📋</Text></View>
            <Text style={styles.quickLabel}>History</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.quickItem} onPress={() => navigation.navigate('Profile')}>
            <View style={styles.quickIcon}><Text style={styles.quickIconText}>👤</Text></View>
            <Text style={styles.quickLabel}>Profile</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.quickItem} onPress={() => navigation.navigate('Notifications')}>
            <View style={[styles.quickIcon, unreadCount > 0 && styles.quickIconBadge]}>
              <Text style={styles.quickIconText}>🔔</Text>
            </View>
            <Text style={styles.quickLabel}>Alerts</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.quickItem} onPress={() => navigation.navigate('DriverRegister')}>
            <View style={[styles.quickIcon, { backgroundColor: '#FFD700' }]}><Text style={styles.quickIconText}>💰</Text></View>
            <Text style={styles.quickLabel}>Earn</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Driver info popup — tap a car pin */}
      <Modal
        visible={!!selectedDriver}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedDriver(null)}
      >
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setSelectedDriver(null)}>
          <View style={styles.driverPopup}>
            <View style={styles.driverPopupHandle} />
            <Text style={styles.driverPopupName}>{selectedDriver?.name || 'Driver'}</Text>
            {selectedDriver?.vehicleModel ? (
              <Text style={styles.driverPopupVehicle}>{selectedDriver.vehicleModel} · {selectedDriver.vehiclePlate}</Text>
            ) : null}
            {selectedDriver?.rating ? (
              <Text style={styles.driverPopupRating}>⭐ {selectedDriver.rating.toFixed(1)}</Text>
            ) : null}
            <View style={styles.driverPopupActions}>
              {selectedDriver?.phone ? (
                <TouchableOpacity
                  style={styles.callDriverBtn}
                  onPress={() => {
                    setSelectedDriver(null);
                    Linking.openURL(`tel:${selectedDriver.phone}`);
                  }}
                >
                  <Text style={styles.callDriverText}>📞 Call Driver</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                style={styles.bookNowBtn}
                onPress={() => {
                  setSelectedDriver(null);
                  navigation.navigate('BookRide', { location, mode: 'ride' });
                }}
              >
                <Text style={styles.bookNowText}>🚗 Book Now</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },

  carPin: {
    width: 38, height: 38, backgroundColor: '#fff', borderRadius: 19,
    justifyContent: 'center', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.22, shadowRadius: 4,
    elevation: 5, borderWidth: 2, borderColor: '#FFD700',
  },
  carPinText: { fontSize: 20 },

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

  topBar: {
    position: 'absolute',
    top: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 24) + 8 : 52,
    left: 12, right: 12,
    flexDirection: 'row', alignItems: 'center', gap: 8,
  },
  menuBtn: {
    width: 44, height: 44, backgroundColor: '#fff', borderRadius: 22,
    justifyContent: 'center', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.12, shadowRadius: 6, elevation: 6,
  },
  menuBtnText: { fontSize: 18, color: '#1a1a2e' },
  searchBar: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#fff', borderRadius: 24, paddingHorizontal: 16, paddingVertical: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.12, shadowRadius: 6, elevation: 6,
  },
  searchIcon: { fontSize: 16 },
  searchText: { flex: 1, color: '#888', fontSize: 15, fontWeight: '500' },
  bellBtn: {
    width: 44, height: 44, backgroundColor: '#fff', borderRadius: 22,
    justifyContent: 'center', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.12, shadowRadius: 6, elevation: 6,
  },
  bellText: { fontSize: 20 },
  badge: {
    position: 'absolute', top: 4, right: 4,
    backgroundColor: '#ef4444', borderRadius: 7, minWidth: 14, height: 14,
    justifyContent: 'center', alignItems: 'center', paddingHorizontal: 2,
  },
  badgeText: { color: '#fff', fontSize: 8, fontWeight: 'bold' },

  liveStatusRow: {
    position: 'absolute',
    top: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 24) + 68 : 106,
    left: 12, flexDirection: 'row', gap: 6,
  },
  liveStatusPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: '#1a1a2eee', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5,
  },
  liveStatusPillRequest: { backgroundColor: '#7c3aedee' },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#4ade80' },
  liveDotRequest: { backgroundColor: '#fbbf24' },
  liveStatusText: { color: '#fff', fontSize: 11, fontWeight: '700' },

  mapControls: {
    position: 'absolute', right: 14, bottom: height * 0.37,
    gap: 8,
  },
  mapCtrlBtn: {
    width: 44, height: 44, backgroundColor: '#fff', borderRadius: 22,
    justifyContent: 'center', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 6, elevation: 6,
  },
  mapCtrlIcon: { fontSize: 20, color: '#1a1a2e' },

  bottomCard: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 28,
    shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.08, shadowRadius: 16, elevation: 20,
  },
  tabs: {
    flexDirection: 'row', backgroundColor: '#f5f5f5', borderRadius: 14, padding: 4, marginBottom: 14,
  },
  tab: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 10, borderRadius: 11,
  },
  tabActive: {
    backgroundColor: '#fff',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 4, elevation: 2,
  },
  tabIcon: { fontSize: 16 },
  tabText: { fontSize: 14, fontWeight: '600', color: '#aaa' },
  tabTextActive: { color: '#1a1a2e' },

  ctaBtn: {
    backgroundColor: '#1a1a2e', borderRadius: 18, paddingVertical: 18,
    alignItems: 'center', marginBottom: 14,
  },
  ctaText: { color: '#FFD700', fontWeight: '800', fontSize: 18 },

  quickRow: { flexDirection: 'row', justifyContent: 'space-around' },
  quickItem: { alignItems: 'center', gap: 5 },
  quickIcon: {
    width: 48, height: 48, backgroundColor: '#f5f5f5', borderRadius: 24,
    justifyContent: 'center', alignItems: 'center',
  },
  quickIconBadge: { backgroundColor: '#fef2f2' },
  quickIconText: { fontSize: 22 },
  quickLabel: { color: '#666', fontSize: 11, fontWeight: '600' },

  modalOverlay: { flex: 1, backgroundColor: '#00000044', justifyContent: 'flex-end' },
  driverPopup: {
    backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 24, paddingBottom: 40,
  },
  driverPopupHandle: {
    width: 40, height: 4, backgroundColor: '#ddd', borderRadius: 2,
    alignSelf: 'center', marginBottom: 16,
  },
  driverPopupName: { fontSize: 20, fontWeight: '700', color: '#1a1a2e', marginBottom: 4 },
  driverPopupVehicle: { color: '#666', fontSize: 14, marginBottom: 4 },
  driverPopupRating: { color: '#888', fontSize: 14, marginBottom: 20 },
  driverPopupActions: { flexDirection: 'row', gap: 10 },
  callDriverBtn: {
    flex: 1, backgroundColor: '#dcfce7', borderRadius: 14, paddingVertical: 14,
    alignItems: 'center',
  },
  callDriverText: { color: '#16a34a', fontWeight: '700', fontSize: 15 },
  bookNowBtn: {
    flex: 1, backgroundColor: '#1a1a2e', borderRadius: 14, paddingVertical: 14,
    alignItems: 'center',
  },
  bookNowText: { color: '#FFD700', fontWeight: '700', fontSize: 15 },
});
