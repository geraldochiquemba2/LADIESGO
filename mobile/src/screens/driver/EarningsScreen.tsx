import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { driversApi } from '../../services/api';

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('pt-PT', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function EarningsScreen() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [trips, setTrips] = useState<any[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (p = 1, append = false) => {
    try {
      const res = await driversApi.getEarnings(p);
      const d = res.data;
      setData(d);
      setTrips((prev) => append ? [...prev, ...d.trips] : d.trips);
    } catch {
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => { load(1); }, []);

  const onRefresh = () => { setRefreshing(true); setPage(1); load(1); };

  const loadMore = () => {
    if (loadingMore || !data || trips.length >= data.total) return;
    const next = page + 1;
    setPage(next);
    setLoadingMore(true);
    load(next, true);
  };

  const renderTrip = ({ item }: { item: any }) => {
    const driverEarnings = (item.finalFare ?? item.fareEstimate) * 0.8;
    return (
      <View style={styles.card}>
        <View style={styles.cardLeft}>
          <Text style={styles.passengerName}>{item.passenger?.name || 'Passenger'}</Text>
          <Text style={styles.route} numberOfLines={1}>{item.pickupAddress}</Text>
          <Text style={styles.route} numberOfLines={1}>→ {item.dropoffAddress}</Text>
          <Text style={styles.date}>{formatDate(item.completedAt || item.createdAt)}</Text>
        </View>
        <View style={styles.cardRight}>
          <Text style={styles.earning}>+{driverEarnings.toFixed(2)}</Text>
          <Text style={styles.earningCurrency}>SAR</Text>
          {item.distanceKm && <Text style={styles.km}>{item.distanceKm} km</Text>}
        </View>
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
      contentContainerStyle={styles.listContent}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#FFD700']} />}
      onEndReached={loadMore}
      onEndReachedThreshold={0.3}
      ListHeaderComponent={
        data && (
          <View style={styles.summary}>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>Total Earnings</Text>
              <Text style={styles.summaryValue}>{data.totalEarnings?.toFixed(2)} SAR</Text>
            </View>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>Completed Trips</Text>
              <Text style={styles.summaryValue}>{data.total}</Text>
            </View>
          </View>
        )
      }
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>💰</Text>
          <Text style={styles.emptyTitle}>No earnings yet</Text>
          <Text style={styles.emptyText}>Go online and accept trips to start earning</Text>
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
  listContent: { padding: 16, gap: 10 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  summary: { flexDirection: 'row', gap: 12, marginBottom: 8 },
  summaryCard: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    borderRadius: 14,
    padding: 16,
    alignItems: 'center',
  },
  summaryLabel: { color: '#aaa', fontSize: 12, marginBottom: 4 },
  summaryValue: { color: '#FFD700', fontSize: 24, fontWeight: 'bold' },

  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  cardLeft: { flex: 1 },
  passengerName: { fontSize: 15, fontWeight: '600', color: '#1a1a2e', marginBottom: 4 },
  route: { color: '#666', fontSize: 12, marginBottom: 2 },
  date: { color: '#aaa', fontSize: 11, marginTop: 4 },
  cardRight: { alignItems: 'flex-end', paddingLeft: 12 },
  earning: { fontSize: 22, fontWeight: 'bold', color: '#16a34a' },
  earningCurrency: { color: '#16a34a', fontSize: 12, fontWeight: '600' },
  km: { color: '#aaa', fontSize: 12, marginTop: 4 },

  empty: { alignItems: 'center', paddingTop: 60 },
  emptyIcon: { fontSize: 56, marginBottom: 16 },
  emptyTitle: { fontSize: 20, fontWeight: 'bold', color: '#1a1a2e', marginBottom: 8 },
  emptyText: { color: '#999', fontSize: 15, textAlign: 'center' },
});
