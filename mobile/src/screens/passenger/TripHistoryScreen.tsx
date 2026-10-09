import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { usersApi } from '../../services/api';

const STATUS_COLORS: Record<string, string> = {
  COMPLETED: '#16a34a',
  CANCELLED: '#ef4444',
  IN_PROGRESS: '#2563eb',
  REQUESTED: '#f59e0b',
  ACCEPTED: '#8b5cf6',
  DRIVER_ARRIVED: '#8b5cf6',
};

const STATUS_LABELS: Record<string, string> = {
  COMPLETED: 'Concluída',
  CANCELLED: 'Cancelada',
  IN_PROGRESS: 'Em curso',
  REQUESTED: 'A procurar',
  ACCEPTED: 'Motorista a caminho',
  DRIVER_ARRIVED: 'Motorista chegou',
};

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('pt-PT', { day: 'numeric', month: 'short', year: 'numeric' }) +
    '  ' + d.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
}

export default function TripHistoryScreen({ navigation }: any) {
  const [trips, setTrips] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadTrips = useCallback(async (p = 1, append = false) => {
    try {
      const res = await usersApi.getTripHistory(p);
      const data = res.data;
      setTotal(data.total);
      setTrips((prev) => append ? [...prev, ...data.trips] : data.trips);
    } catch {
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => { loadTrips(1); }, []);

  const onRefresh = () => {
    setRefreshing(true);
    setPage(1);
    loadTrips(1);
  };

  const loadMore = () => {
    if (loadingMore || trips.length >= total) return;
    const next = page + 1;
    setPage(next);
    setLoadingMore(true);
    loadTrips(next, true);
  };

  const renderTrip = ({ item }: { item: any }) => {
    const hasRated = item.ratings?.length > 0;
    const fare = item.finalFare ?? item.fareEstimate;
    const driverName = item.driver?.user?.name || 'No driver';

    return (
      <View style={styles.card}>
        {/* Header */}
        <View style={styles.cardHeader}>
          <Text style={styles.cardDate}>{formatDate(item.createdAt)}</Text>
          <View style={[styles.badge, { backgroundColor: STATUS_COLORS[item.status] + '20' }]}>
            <Text style={[styles.badgeText, { color: STATUS_COLORS[item.status] }]}>
              {STATUS_LABELS[item.status] || item.status}
            </Text>
          </View>
        </View>

        {/* Route */}
        <View style={styles.routeRow}>
          <View style={styles.routeDots}>
            <View style={styles.dotFrom} />
            <View style={styles.routeLine} />
            <View style={styles.dotTo} />
          </View>
          <View style={styles.routeAddresses}>
            <Text style={styles.addressFrom} numberOfLines={1}>{item.pickupAddress}</Text>
            <Text style={styles.addressTo} numberOfLines={1}>{item.dropoffAddress}</Text>
          </View>
        </View>

        {/* Footer */}
        <View style={styles.cardFooter}>
          <View style={styles.footerLeft}>
            <Text style={styles.driverLabel}>Driver</Text>
            <Text style={styles.driverName}>{driverName}</Text>
          </View>
          <View style={styles.footerRight}>
            {item.distanceKm && (
              <Text style={styles.distance}>{item.distanceKm} km</Text>
            )}
            <Text style={styles.fare}>{fare} SAR</Text>
          </View>
        </View>

        {/* Rate button */}
        {item.status === 'COMPLETED' && !hasRated && (
          <TouchableOpacity
            style={styles.rateBtn}
            onPress={() => navigation.navigate('RateTrip', { trip: item })}
          >
            <Text style={styles.rateBtnText}>⭐ Rate this trip</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#FFD700" />
      </View>
    );
  }

  return (
    <FlatList
      style={styles.list}
      data={trips}
      keyExtractor={(item) => item.id}
      renderItem={renderTrip}
      contentContainerStyle={trips.length === 0 ? styles.emptyContainer : styles.listContent}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#FFD700']} />}
      onEndReached={loadMore}
      onEndReachedThreshold={0.3}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>🚕</Text>
          <Text style={styles.emptyTitle}>No trips yet</Text>
          <Text style={styles.emptyText}>Your trip history will appear here</Text>
        </View>
      }
      ListFooterComponent={
        loadingMore ? <ActivityIndicator color="#FFD700" style={{ margin: 16 }} /> : null
      }
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: '#f5f5f5' },
  listContent: { padding: 16, gap: 12 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },

  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  cardDate: { color: '#666', fontSize: 13 },
  badge: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { fontSize: 12, fontWeight: '700' },

  routeRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  routeDots: { alignItems: 'center', marginRight: 12, paddingTop: 3 },
  dotFrom: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#FFD700', borderWidth: 2, borderColor: '#1a1a2e' },
  routeLine: { width: 2, height: 28, backgroundColor: '#ddd', marginVertical: 3 },
  dotTo: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#1a1a2e' },
  routeAddresses: { flex: 1, gap: 16 },
  addressFrom: { color: '#1a1a2e', fontSize: 14, fontWeight: '500' },
  addressTo: { color: '#1a1a2e', fontSize: 14, fontWeight: '500' },

  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', borderTopWidth: 1, borderTopColor: '#f0f0f0', paddingTop: 12 },
  footerLeft: {},
  driverLabel: { color: '#aaa', fontSize: 11 },
  driverName: { color: '#1a1a2e', fontWeight: '600', fontSize: 14 },
  footerRight: { alignItems: 'flex-end' },
  distance: { color: '#aaa', fontSize: 12 },
  fare: { color: '#1a1a2e', fontWeight: 'bold', fontSize: 18, marginTop: 2 },

  rateBtn: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#FFD700',
    borderRadius: 10,
    padding: 10,
    alignItems: 'center',
    backgroundColor: '#FFFDE7',
  },
  rateBtnText: { color: '#1a1a2e', fontWeight: '600', fontSize: 14 },

  empty: { alignItems: 'center' },
  emptyIcon: { fontSize: 56, marginBottom: 16 },
  emptyTitle: { fontSize: 20, fontWeight: 'bold', color: '#1a1a2e', marginBottom: 8 },
  emptyText: { color: '#999', fontSize: 15, textAlign: 'center' },
});
