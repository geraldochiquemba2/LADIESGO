import React, { useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
} from 'react-native';
import * as Location from 'expo-location';
import { useDispatch, useSelector } from 'react-redux';
import { cancelTrip, setDriverInfo } from '../../store/slices/tripSlice';
import { AppDispatch, RootState } from '../../store';
import { socketService } from '../../services/socket';

export default function FindingDriverScreen({ navigation }: any) {
  const dispatch = useDispatch<AppDispatch>();
  const { currentTrip } = useSelector((s: RootState) => s.trip);

  useEffect(() => {
    if (!currentTrip?.id) return;

    let locationInterval: ReturnType<typeof setInterval>;

    const setup = async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();

      await socketService.connect();

      // Broadcast trip to all online drivers
      socketService.emit('passenger:trip-request', { tripId: currentTrip.id });

      // Share passenger location so drivers see it immediately
      if (status === 'granted') {
        const loc = await Location.getCurrentPositionAsync({});
        socketService.emit('passenger:location-update', {
          lat: loc.coords.latitude,
          lng: loc.coords.longitude,
        });

        locationInterval = setInterval(async () => {
          const l = await Location.getCurrentPositionAsync({});
          socketService.emit('passenger:location-update', {
            lat: l.coords.latitude,
            lng: l.coords.longitude,
          });
        }, 10000);
      }

      // When a driver accepts
      socketService.on('server:driver-found', (data) => {
        dispatch(setDriverInfo(data.driver));
        navigation.replace('DriverFound');
      });
    };

    setup();

    return () => {
      clearInterval(locationInterval);
      socketService.off('server:driver-found');
    };
  }, [currentTrip?.id]);

  const handleCancel = async () => {
    if (currentTrip) {
      socketService.emit('passenger:cancel-trip', { tripId: currentTrip.id });
      await dispatch(cancelTrip({ id: currentTrip.id, reason: 'Cancelled by passenger' }));
      navigation.goBack();
    }
  };

  const trip = currentTrip;
  const isScheduled = !!trip?.scheduledAt;

  return (
    <View style={styles.container}>
      <View style={styles.spinner}>
        <ActivityIndicator size="large" color="#FFD700" />
        <View style={styles.ring} />
      </View>
      <Text style={styles.title}>
        {isScheduled ? '🗓️ Ride Scheduled!' : 'Finding your driver...'}
      </Text>
      <Text style={styles.subtitle}>
        {isScheduled
          ? `Your ride is booked for ${new Date(trip!.scheduledAt!).toLocaleString('pt-PT', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
          : "We're connecting you with a nearby driver"}
      </Text>

      <View style={styles.fareCard}>
        <Text style={styles.fareLbl}>Estimated fare</Text>
        <Text style={styles.fareVal}>{trip?.fareEstimate ?? '—'} SAR</Text>
        <Text style={styles.fareType}>{trip?.rideType ?? 'ECONOMY'} · {trip?.paymentMethod === 'CASH' ? '💵 Cash' : '💳 Card'}</Text>
      </View>

      <Text style={styles.hint}>📍 Sharing your location with nearby drivers</Text>

      {!isScheduled && (
        <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
      )}
      {isScheduled && (
        <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel}>
          <Text style={styles.cancelText}>Cancel Booking</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 24,
  },
  spinner: { alignItems: 'center', justifyContent: 'center', marginBottom: 32 },
  ring: {
    position: 'absolute',
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 2,
    borderColor: '#FFD70033',
  },
  title: { fontSize: 22, fontWeight: 'bold', color: '#1a1a2e', marginBottom: 8, textAlign: 'center' },
  subtitle: { color: '#666', fontSize: 15, textAlign: 'center', marginBottom: 14, paddingHorizontal: 20 },
  hint: { color: '#aaa', fontSize: 13, textAlign: 'center', marginBottom: 24 },

  fareCard: {
    backgroundColor: '#f8f8f8', borderRadius: 16, paddingHorizontal: 32, paddingVertical: 18,
    alignItems: 'center', marginBottom: 20, borderWidth: 1, borderColor: '#e5e5e5',
  },
  fareLbl: { color: '#999', fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  fareVal: { color: '#1a1a2e', fontSize: 32, fontWeight: '900', marginTop: 4 },
  fareType: { color: '#888', fontSize: 13, marginTop: 4 },

  cancelBtn: {
    borderWidth: 1.5,
    borderColor: '#ef4444',
    borderRadius: 14,
    paddingHorizontal: 40,
    paddingVertical: 14,
  },
  cancelText: { color: '#ef4444', fontWeight: 'bold', fontSize: 16 },
});
