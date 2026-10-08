import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  TextInput,
  ScrollView,
  type NativeSyntheticEvent,
} from 'react-native';
import {
  Map as MapLibreMap,
  Camera,
  Marker,
  UserLocation,
  GeoJSONSource,
  Layer,
  type CameraRef,
  type PressEvent,
} from '@maplibre/maplibre-react-native';
import { MAP_STYLE, fitCoordinates } from '../../components/appMap';
import {
  curvePath,
  fetchRoute,
  fetchZone,
  searchPlaces,
  toGeoJSONLine,
  type PlaceHit,
} from '../../services/geo';
import MapAttribution from '../../components/MapAttribution';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useDispatch, useSelector } from 'react-redux';
import { estimateFare, requestTrip } from '../../store/slices/tripSlice';
import { AppDispatch, RootState } from '../../store';

const RIDE_TYPES = [
  { key: 'ECONOMY', label: 'Económico', icon: '🚗', desc: 'Acessível · 3–5 min' },
  { key: 'COMFORT', label: 'Conforto', icon: '🚙', desc: 'Carros novos · 4–6 min' },
  { key: 'PREMIUM', label: 'Família', icon: '🚘', desc: 'Espaçoso · 5–8 min' },
] as const;

type Step = 'map' | 'choose';

export default function BookRideScreen({ navigation, route }: any) {
  const { location, mode } = route.params as { location: { latitude: number; longitude: number }; mode?: 'ride' | 'deliver' };
  const isDelivery = mode === 'deliver';
  const dispatch = useDispatch<AppDispatch>();
  const { fareEstimate, loading } = useSelector((s: RootState) => s.trip);

  const cameraRef = useRef<CameraRef>(null);
  const [step, setStep] = useState<Step>('map');
  const [dropoff, setDropoff] = useState<{ latitude: number; longitude: number } | null>(null);
  const [dropoffLabel, setDropoffLabel] = useState('');
  const [pickupLabel, setPickupLabel] = useState('Current Location');
  const [selectedType, setSelectedType] = useState<'ECONOMY' | 'COMFORT' | 'PREMIUM'>('ECONOMY');
  const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'CARD'>('CASH');
  const [estimating, setEstimating] = useState(false);
  const [packageDescription, setPackageDescription] = useState('');
  const [receiverName, setReceiverName] = useState('');

  // Referência de prédio/porta (ex: Kilamba Bloco D, prédio K12, porta 3)
  const [pickupRef, setPickupRef] = useState('');
  const [dropoffRef, setDropoffRef] = useState('');

  // Rota: curva imediata + substituição pela rota real (estratégia da web)
  const [routePoints, setRoutePoints] = useState<[number, number][]>([]);
  const [routeMeta, setRouteMeta] = useState<{ distanceKm: number | null; durationMin: number | null; real: boolean } | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const routeSeq = useRef(0);

  // Pesquisa de destino (Nominatim, limitada a Luanda)
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [searching, setSearching] = useState(false);

  // Recentes (últimos 5 destinos, como Uber/Bolt)
  const [recents, setRecents] = useState<PlaceHit[]>([]);
  React.useEffect(() => {
    AsyncStorage.getItem('recentDestinations')
      .then((s) => {
        if (s) setRecents(JSON.parse(s));
      })
      .catch(() => {});
  }, []);
  const saveRecent = (coord: { latitude: number; longitude: number }, label: string) => {
    const entry = { name: label, lat: coord.latitude, lng: coord.longitude };
    setRecents((prev) => {
      const next = [
        entry,
        ...prev.filter(
          (r) =>
            Math.abs(r.lat - entry.lat) > 0.0005 || Math.abs(r.lng - entry.lng) > 0.0005,
        ),
      ].slice(0, 5);
      AsyncStorage.setItem('recentDestinations', JSON.stringify(next)).catch(() => {});
      return next;
    });
  };

  const SAVED = [
    { key: 'Casa', label: '🏠 Casa', lat: -8.8572, lng: 13.2765 },
    { key: 'Trabalho', label: '💼 Trabalho', lat: -8.8136, lng: 13.2889 },
    { key: 'Shopping', label: '🛍️ Shopping', lat: -8.9225, lng: 13.18 },
  ] as const;

  const loadRoute = async (to: { latitude: number; longitude: number }) => {
    const my = ++routeSeq.current;
    const fromLL: [number, number] = [location.latitude, location.longitude];
    const toLL: [number, number] = [to.latitude, to.longitude];
    // Desenho imediato (curva) para não deixar o mapa vazio
    setRoutePoints(curvePath(fromLL, toLL));
    setRouteMeta(null);
    setRouteLoading(true);
    const info = await fetchRoute(fromLL, toLL);
    if (routeSeq.current !== my) return;
    setRoutePoints(info.points);
    setRouteMeta({ distanceKm: info.distanceKm, durationMin: info.durationMin, real: info.real });
    setRouteLoading(false);
  };

  const pickDropoff = async (coord: { latitude: number; longitude: number }, label?: string) => {
    setDropoff(coord);
    setDropoffLabel(label ?? `${coord.latitude.toFixed(4)}, ${coord.longitude.toFixed(4)}`);
    setHits([]);
    setSearch('');
    saveRecent(coord, label ?? dropoffLabel);
    fitCoordinates(
      cameraRef.current,
      [[location.longitude, location.latitude], [coord.longitude, coord.latitude]],
      { top: 80, right: 60, bottom: 340, left: 60 },
    );
    loadRoute(coord);
    // Nome legível da zona (backend /api/zone, como na web)
    try {
      const zone = await fetchZone(coord.latitude, coord.longitude);
      if (zone && !label) setDropoffLabel(zone);
    } catch {}
  };

  // Pesquisa com debounce (500 ms)
  React.useEffect(() => {
    if (search.trim().length < 3) {
      setHits([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      const res = await searchPlaces(search, location);
      setHits(res);
      setSearching(false);
    }, 500);
    return () => clearTimeout(t);
  }, [search]);

  // Resolve pickup address once on mount
  React.useEffect(() => {
    Location.reverseGeocodeAsync({ latitude: location.latitude, longitude: location.longitude })
      .then(([place]) => {
        if (place) {
          const parts = [place.name, place.street, place.district, place.city].filter(Boolean);
          if (parts.length > 0) setPickupLabel(parts.slice(0, 2).join(', '));
        }
      })
      .catch(() => {});
  }, []);

  const handleMapPress = async (e: NativeSyntheticEvent<PressEvent>) => {
    const [lng, lat] = e.nativeEvent.lngLat;
    pickDropoff({ latitude: lat, longitude: lng });
  };

  const handleEstimate = async () => {
    if (!dropoff) return Alert.alert('Set Destination', 'Tap the map to pick a destination');
    setEstimating(true);
    try {
      await dispatch(estimateFare({
        pickupLat: location.latitude, pickupLng: location.longitude,
        dropoffLat: dropoff.latitude, dropoffLng: dropoff.longitude,
      })).unwrap();
      setStep('choose');
    } catch (e: any) {
      const msg = typeof e === 'string' ? e : e?.message || 'Could not get fare estimate. Try again.';
      Alert.alert('Error', msg);
    } finally {
      setEstimating(false);
    }
  };

  const handleBook = async () => {
    if (!dropoff) return;
    if (isDelivery && !packageDescription.trim()) {
      return Alert.alert('Package Info', 'Please describe what you are sending');
    }
    try {
      await dispatch(requestTrip({
        pickupAddress: pickupLabel,
        pickupLat: location.latitude, pickupLng: location.longitude,
        pickupRef: pickupRef.trim() || undefined,
        dropoffAddress: dropoffLabel,
        dropoffLat: dropoff.latitude, dropoffLng: dropoff.longitude,
        dropoffRef: dropoffRef.trim() || undefined,
        paymentMethod,
        rideType: isDelivery ? 'ECONOMY' : selectedType,
        ...(isDelivery && {
          tripType: 'DELIVERY',
          packageDescription: packageDescription.trim(),
          receiverName: receiverName.trim() || undefined,
        }),
      })).unwrap();
      navigation.navigate('FindingDriver');
    } catch (e: any) {
      const msg = typeof e === 'string' ? e : e?.message || 'Could not book. Try again.';
      Alert.alert('Booking Failed', msg);
    }
  };

  const surge = fareEstimate?.surgeActive;
  const surgeMultiplier = fareEstimate?.surgeMultiplier ?? 1;
  const selectedOption = fareEstimate?.options?.find((o: any) => o.type === selectedType);
  const fare = selectedOption?.fare ?? fareEstimate?.estimatedFare ?? 0;

  return (
    <View style={styles.container}>
      <MapLibreMap
        style={styles.map}
        mapStyle={MAP_STYLE}
        onPress={step === 'map' ? handleMapPress : undefined}
        attribution={false}
        logo={false}
        compass={false}
      >
        <Camera
          ref={cameraRef}
          initialViewState={{ center: [location.longitude, location.latitude], zoom: 13 }}
        />
        <UserLocation />
        <Marker lngLat={[location.longitude, location.latitude]} anchor="center">
          <View style={styles.pickupDot}><View style={styles.pickupInner} /></View>
        </Marker>
        {dropoff && routePoints.length > 0 && (
          <>
            <Marker lngLat={[dropoff.longitude, dropoff.latitude]} anchor="bottom">
              <Text style={styles.dropoffPinText}>📍</Text>
            </Marker>
            <GeoJSONSource
              id="routeSource"
              data={toGeoJSONLine(routePoints)}
            >
              <Layer
                id="routeLine"
                type="line"
                style={{ lineColor: '#61188E', lineWidth: 5, lineOpacity: 0.9 }}
              />
            </GeoJSONSource>
          </>
        )}
      </MapLibreMap>
      <MapAttribution />

      {/* Step 1: pick destination */}
      {step === 'map' && (
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.sheetTitle}>{isDelivery ? '📦 Where to deliver?' : 'Where to?'}</Text>

          <View style={styles.locationRow}>
            <View style={styles.dotGreen} />
            <View style={styles.locationTexts}>
              <Text style={styles.locationLabel}>Pickup</Text>
              <Text style={styles.locationValue}>{pickupLabel}</Text>
            </View>
          </View>
          <View style={styles.dashedLine} />

          <TextInput
            style={styles.refInput}
            placeholder="🏢 Prédio/porta na origem (ex: Bloco D, K12)"
            placeholderTextColor="#bbb"
            value={pickupRef}
            onChangeText={setPickupRef}
            maxLength={120}
          />

          <View style={styles.locationRow}>
            <View style={styles.dotBlack} />
            <View style={styles.locationTexts}>
              <Text style={styles.locationLabel}>Destino</Text>
              <Text style={[styles.locationValue, !dropoff && styles.placeholder]}>
                {dropoff ? dropoffLabel : 'Pesquisa ou toca no mapa'}
              </Text>
            </View>
            {dropoff && (
              <TouchableOpacity onPress={() => { setDropoff(null); setDropoffLabel(''); setRoutePoints([]); setRouteMeta(null); }}>
                <Text style={styles.clearX}>✕</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Pesquisa de destino (como na web: texto + pontos guardados + mapa) */}
          <TextInput
            style={styles.labelInput}
            placeholder="🔍 Pesquisar destino em Luanda..."
            placeholderTextColor="#bbb"
            value={search}
            onChangeText={setSearch}
          />
          {searching && <Text style={styles.searchHint}>A procurar...</Text>}
          {search.trim() === '' && recents.length > 0 && (
            <>
              <Text style={styles.sectionLabel}>🕐 Recentes</Text>
              {recents.map((h, i) => (
                <TouchableOpacity
                  key={`r${h.lat},${h.lng},${i}`}
                  style={styles.hitRow}
                  onPress={() => pickDropoff({ latitude: h.lat, longitude: h.lng }, h.name)}
                >
                  <Text style={styles.hitIcon}>🕐</Text>
                  <Text style={styles.hitText} numberOfLines={1}>{h.name}</Text>
                </TouchableOpacity>
              ))}
            </>
          )}
          {hits.map((h, i) => (
            <TouchableOpacity
              key={`${h.lat},${h.lng},${i}`}
              style={styles.hitRow}
              onPress={() => pickDropoff({ latitude: h.lat, longitude: h.lng }, h.name)}
            >
              <Text style={styles.hitIcon}>📍</Text>
              <Text style={styles.hitText} numberOfLines={1}>{h.name}</Text>
            </TouchableOpacity>
          ))}

          <View style={styles.savedRow}>
            {SAVED.map((s) => (
              <TouchableOpacity
                key={s.key}
                style={styles.savedBtn}
                onPress={() => pickDropoff({ latitude: s.lat, longitude: s.lng }, s.key)}
              >
                <Text style={styles.savedText}>{s.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {dropoff && (
            <TextInput
              style={styles.refInput}
              placeholder="🏢 Prédio/porta no destino (ex: Bloco J, P4)"
              placeholderTextColor="#bbb"
              value={dropoffRef}
              onChangeText={setDropoffRef}
              maxLength={120}
            />
          )}

          {/* Distância/tempo reais pela estrada (OSRM) */}
          {dropoff && routeMeta?.distanceKm != null && (
            <Text style={styles.routeInfo}>
              🛣️ {routeMeta.distanceKm.toFixed(1).replace('.', ',')} km
              {routeMeta.durationMin != null && ` · ~${Math.max(1, Math.round(routeMeta.durationMin))} min`}
              {!routeMeta.real && ' · estimado'}
            </Text>
          )}
          {dropoff && routeLoading && !routeMeta && (
            <Text style={styles.routeInfo}>A calcular rota...</Text>
          )}

          {dropoff && (
            <TextInput
              style={styles.labelInput}
              placeholder="Add a label (optional)"
              placeholderTextColor="#bbb"
              value={dropoffLabel}
              onChangeText={setDropoffLabel}
            />
          )}

          <TouchableOpacity
            style={[styles.primaryBtn, !dropoff && styles.primaryBtnDisabled]}
            onPress={handleEstimate}
            disabled={!dropoff || estimating}
          >
            {estimating
              ? <ActivityIndicator color="#1a1a2e" />
              : <Text style={styles.primaryBtnText}>{isDelivery ? 'See Delivery Price →' : 'See Ride Options →'}</Text>}
          </TouchableOpacity>
        </View>
      )}

      {/* Step 2: choose ride type + book */}
      {step === 'choose' && fareEstimate && (
        <ScrollView style={styles.sheet} contentContainerStyle={styles.chooseContent} keyboardShouldPersistTaps="handled">
          <View style={styles.handle} />

          {surge && (
            <View style={styles.surgeBanner}>
              <Text style={styles.surgeIcon}>⚡</Text>
              <View>
                <Text style={styles.surgeTitle}>Muita procura · {surgeMultiplier.toFixed(1)}x</Text>
                <Text style={styles.surgeDesc}>Preços um pouco mais altos agora</Text>
              </View>
            </View>
          )}

          <View style={styles.tripInfo}>
            <Text style={styles.tripDist}>{fareEstimate.distanceKm} km</Text>
            <View style={styles.tripRoute}>
              <View style={styles.dotGreenSm} />
              <Text style={styles.tripRouteText} numberOfLines={1}>{pickupLabel}</Text>
            </View>
            <View style={styles.tripRoute}>
              <View style={styles.dotBlackSm} />
              <Text style={styles.tripRouteText} numberOfLines={1}>{dropoffLabel}</Text>
            </View>
          </View>

          {isDelivery ? (
            <>
              <Text style={styles.sectionLabel}>Delivery</Text>
              <View style={[styles.rideCard, styles.rideCardActive]}>
                <Text style={styles.rideIcon}>📦</Text>
                <View style={styles.rideInfo}>
                  <Text style={[styles.rideName, styles.rideNameActive]}>Package Delivery</Text>
                  <Text style={styles.rideDesc}>Driver picks up &amp; delivers · 3–5 min</Text>
                </View>
                <View style={styles.ridePriceCol}>
                  <Text style={[styles.ridePrice, styles.ridePriceActive]}>
                    {fareEstimate.options?.find((o: any) => o.type === 'ECONOMY')?.fare ?? fareEstimate.estimatedFare} Kz
                  </Text>
                </View>
              </View>

              <Text style={styles.sectionLabel}>Package details</Text>
              <TextInput
                style={styles.packageInput}
                placeholder="What are you sending? (e.g. documents, food) *"
                placeholderTextColor="#bbb"
                value={packageDescription}
                onChangeText={setPackageDescription}
              />
              <TextInput
                style={styles.packageInput}
                placeholder="Receiver name (optional)"
                placeholderTextColor="#bbb"
                value={receiverName}
                onChangeText={setReceiverName}
              />
            </>
          ) : (
            <>
          <Text style={styles.sectionLabel}>Escolhe a viagem</Text>
          {RIDE_TYPES.map((rt) => {
            const opt = fareEstimate.options?.find((o: any) => o.type === rt.key);
            const rtFare = opt?.fare ?? fareEstimate.estimatedFare;
            const active = selectedType === rt.key;
            return (
              <TouchableOpacity
                key={rt.key}
                style={[styles.rideCard, active && styles.rideCardActive]}
                onPress={() => setSelectedType(rt.key)}
              >
                <Text style={styles.rideIcon}>{rt.icon}</Text>
                <View style={styles.rideInfo}>
                  <Text style={[styles.rideName, active && styles.rideNameActive]}>{rt.label}</Text>
                  <Text style={styles.rideDesc}>{rt.desc}</Text>
                </View>
                <View style={styles.ridePriceCol}>
                  <Text style={[styles.ridePrice, active && styles.ridePriceActive]}>{rtFare} Kz</Text>
                  {active && <View style={styles.selectedCheck}><Text style={styles.checkText}>✓</Text></View>}
                </View>
              </TouchableOpacity>
            );
          })}
            </>
          )}

          <Text style={styles.sectionLabel}>Pagamento</Text>
          <View style={styles.payRow}>
            {(['CASH', 'CARD'] as const).map((m) => (
              <TouchableOpacity
                key={m}
                style={[styles.payBtn, paymentMethod === m && styles.payBtnActive]}
                onPress={() => setPaymentMethod(m)}
              >
                <Text style={styles.payIcon}>{m === 'CASH' ? '💵' : '💳'}</Text>
                <Text style={[styles.payBtnText, paymentMethod === m && styles.payBtnTextActive]}>
                  {m === 'CASH' ? 'Numerário' : 'Cartão'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.bookRow}>
            <TouchableOpacity style={styles.backBtn} onPress={() => setStep('map')}>
              <Text style={styles.backBtnText}>← Back</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.bookBtn} onPress={handleBook} disabled={loading}>
              {loading ? (
                <ActivityIndicator color="#1a1a2e" />
              ) : (
                <View style={{ alignItems: 'center' }}>
                  <Text style={styles.bookBtnText}>
                    {isDelivery ? '📦 Send Package' : `Book ${RIDE_TYPES.find(r => r.key === selectedType)?.label}`}
                  </Text>
                  <Text style={styles.bookBtnSub}>
                    {isDelivery
                      ? (fareEstimate.options?.find((o: any) => o.type === 'ECONOMY')?.fare ?? fareEstimate.estimatedFare)
                      : fare} Kz
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          </View>
        </ScrollView>
      )}

      {step === 'map' && !dropoff && (
        <View style={styles.mapHint}>
          <Text style={styles.mapHintText}>
            {isDelivery ? '👆 Tap map to set delivery point' : '👆 Tap map to set destination'}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },

  pickupDot: {
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: '#fff', borderWidth: 3, borderColor: '#1a1a2e',
    justifyContent: 'center', alignItems: 'center',
  },
  pickupInner: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#1a1a2e' },
  dropoffPinText: { fontSize: 32 },

  mapHint: {
    position: 'absolute', top: 16, alignSelf: 'center',
    backgroundColor: 'rgba(26,26,46,0.88)', paddingHorizontal: 18, paddingVertical: 10, borderRadius: 24,
  },
  mapHintText: { color: '#FFD700', fontWeight: '700', fontSize: 14 },

  sheet: {
    backgroundColor: '#fff', borderTopLeftRadius: 28, borderTopRightRadius: 28,
    maxHeight: '60%', elevation: 20,
    shadowColor: '#000', shadowOffset: { width: 0, height: -6 }, shadowOpacity: 0.12, shadowRadius: 16,
  },
  chooseContent: { padding: 20, paddingBottom: 36 },
  handle: { width: 40, height: 4, backgroundColor: '#e5e5e5', borderRadius: 2, alignSelf: 'center', marginTop: 10, marginBottom: 16 },
  sheetTitle: { fontSize: 22, fontWeight: '800', color: '#1a1a2e', paddingHorizontal: 20, marginBottom: 18 },

  locationRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 6 },
  dotGreen: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#22c55e', marginRight: 14 },
  dotBlack: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#1a1a2e', marginRight: 14 },
  dotGreenSm: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#22c55e', marginRight: 8 },
  dotBlackSm: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#1a1a2e', marginRight: 8 },
  dashedLine: { width: 2, height: 16, backgroundColor: '#ddd', marginLeft: 25 },
  locationTexts: { flex: 1 },
  locationLabel: { color: '#aaa', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: '700' },
  locationValue: { color: '#1a1a2e', fontSize: 14, fontWeight: '600', marginTop: 1 },
  placeholder: { color: '#bbb', fontWeight: '400' },
  clearX: { color: '#ccc', fontSize: 18, paddingLeft: 10 },

  labelInput: {
    marginHorizontal: 20, marginTop: 8, borderWidth: 1.5, borderColor: '#e5e5e5',
    borderRadius: 12, padding: 12, fontSize: 14, color: '#1a1a2e', backgroundColor: '#f9f9f9',
  },
  refInput: {
    marginHorizontal: 20, marginTop: 8, borderWidth: 1.5, borderColor: '#61188E',
    borderRadius: 12, padding: 12, fontSize: 14, color: '#1a1a2e', backgroundColor: '#faf5ff',
  },
  searchHint: { color: '#aaa', fontSize: 12, paddingHorizontal: 24, marginTop: 6 },
  hitRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 20, marginTop: 6, padding: 10,
    backgroundColor: '#f6f4fa', borderRadius: 10,
  },
  hitIcon: { fontSize: 14 },
  hitText: { flex: 1, color: '#1a1a2e', fontSize: 13 },
  savedRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, marginTop: 10 },
  savedBtn: {
    flex: 1, borderWidth: 1.5, borderColor: '#e5e5e5', borderRadius: 12,
    paddingVertical: 10, alignItems: 'center', backgroundColor: '#fafafa',
  },
  savedText: { color: '#1a1a2e', fontWeight: '700', fontSize: 13 },
  routeInfo: {
    color: '#61188E', fontSize: 13, fontWeight: '700',
    paddingHorizontal: 20, marginTop: 10, marginBottom: 4,
  },
  packageInput: {
    borderWidth: 1.5, borderColor: '#e5e5e5', borderRadius: 12, padding: 13,
    fontSize: 14, color: '#1a1a2e', backgroundColor: '#f9f9f9', marginBottom: 10,
  },

  primaryBtn: {
    backgroundColor: '#FFD700', margin: 20, marginTop: 16,
    borderRadius: 16, padding: 17, alignItems: 'center',
  },
  primaryBtnDisabled: { opacity: 0.38 },
  primaryBtnText: { color: '#1a1a2e', fontWeight: '800', fontSize: 16 },

  surgeBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#FFF3CD', borderRadius: 14, padding: 14, marginBottom: 14,
    borderWidth: 1, borderColor: '#FFD700',
  },
  surgeIcon: { fontSize: 28 },
  surgeTitle: { fontSize: 14, fontWeight: '700', color: '#1a1a2e' },
  surgeDesc: { fontSize: 12, color: '#888', marginTop: 2 },

  tripInfo: { backgroundColor: '#f8f8f8', borderRadius: 14, padding: 14, marginBottom: 16 },
  tripDist: { fontSize: 12, color: '#aaa', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  tripRoute: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  tripRouteText: { color: '#1a1a2e', fontSize: 13, flex: 1 },

  sectionLabel: { fontSize: 12, color: '#aaa', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10 },

  rideCard: {
    flexDirection: 'row', alignItems: 'center', padding: 14, borderRadius: 16,
    borderWidth: 1.5, borderColor: '#f0f0f0', marginBottom: 10, backgroundColor: '#fafafa',
  },
  rideCardActive: { borderColor: '#FFD700', backgroundColor: '#FFFDE7' },
  rideIcon: { fontSize: 32, marginRight: 14 },
  rideInfo: { flex: 1 },
  rideName: { fontSize: 16, fontWeight: '700', color: '#666' },
  rideNameActive: { color: '#1a1a2e' },
  rideDesc: { fontSize: 12, color: '#aaa', marginTop: 2 },
  ridePriceCol: { alignItems: 'flex-end', gap: 4 },
  ridePrice: { fontSize: 17, fontWeight: '700', color: '#aaa' },
  ridePriceActive: { color: '#1a1a2e' },
  selectedCheck: {
    backgroundColor: '#FFD700', borderRadius: 10, width: 20, height: 20,
    justifyContent: 'center', alignItems: 'center',
  },
  checkText: { fontSize: 11, fontWeight: '900', color: '#1a1a2e' },

  payRow: { flexDirection: 'row', gap: 10, marginBottom: 18 },
  payBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderWidth: 1.5, borderColor: '#e5e5e5', borderRadius: 14, padding: 14, backgroundColor: '#f8f8f8',
  },
  payBtnActive: { borderColor: '#FFD700', backgroundColor: '#FFFDE7' },
  payIcon: { fontSize: 20 },
  payBtnText: { color: '#999', fontWeight: '600', fontSize: 15 },
  payBtnTextActive: { color: '#1a1a2e' },

  bookRow: { flexDirection: 'row', gap: 10 },
  backBtn: {
    borderWidth: 1.5, borderColor: '#e5e5e5', borderRadius: 16, padding: 16, alignItems: 'center', flex: 1,
  },
  backBtnText: { color: '#888', fontWeight: '600', fontSize: 15 },
  bookBtn: { flex: 2, backgroundColor: '#1a1a2e', borderRadius: 16, padding: 16, alignItems: 'center' },
  bookBtnText: { color: '#FFD700', fontWeight: '800', fontSize: 17 },
  bookBtnSub: { color: '#aaa', fontSize: 12, marginTop: 2 },
});
