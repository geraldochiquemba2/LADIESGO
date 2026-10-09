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
import { notificationsApi } from '../../services/api';

const TYPE_ICONS: Record<string, string> = {
  TRIP_REQUEST: '🚖',
  TRIP_ACCEPTED: '✅',
  DRIVER_ARRIVED: '📍',
  TRIP_STARTED: '🚀',
  TRIP_COMPLETED: '🎉',
  TRIP_CANCELLED: '❌',
  PAYMENT: '💳',
  GENERAL: '🔔',
};

function formatTime(iso: string) {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60000) return 'Agora mesmo';
  if (diff < 3600000) return `há ${Math.floor(diff / 60000)} min`;
  if (diff < 86400000) return `há ${Math.floor(diff / 3600000)} h`;
  return d.toLocaleDateString('pt-PT', { day: 'numeric', month: 'short' });
}

export default function NotificationsScreen() {
  const [notifications, setNotifications] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (p = 1, append = false) => {
    try {
      const res = await notificationsApi.getAll(p);
      const data = res.data;
      setTotal(data.total);
      setNotifications((prev) => append ? [...prev, ...data.notifications] : data.notifications);
      if (p === 1 && data.notifications.some((n: any) => !n.isRead)) {
        await notificationsApi.markAllRead();
      }
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
    if (loadingMore || notifications.length >= total) return;
    const next = page + 1;
    setPage(next);
    setLoadingMore(true);
    load(next, true);
  };

  const renderItem = ({ item }: { item: any }) => (
    <View style={[styles.card, !item.isRead && styles.cardUnread]}>
      <View style={styles.iconWrap}>
        <Text style={styles.icon}>{TYPE_ICONS[item.type] ?? '🔔'}</Text>
      </View>
      <View style={styles.body}>
        <Text style={styles.title}>{item.title}</Text>
        <Text style={styles.bodyText}>{item.body}</Text>
        <Text style={styles.time}>{formatTime(item.createdAt)}</Text>
      </View>
      {!item.isRead && <View style={styles.dot} />}
    </View>
  );

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
      data={notifications}
      keyExtractor={(item) => item.id}
      renderItem={renderItem}
      contentContainerStyle={notifications.length === 0 ? styles.emptyContainer : styles.listContent}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#FFD700']} />}
      onEndReached={loadMore}
      onEndReachedThreshold={0.3}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>🔔</Text>
          <Text style={styles.emptyTitle}>Sem notificações</Text>
          <Text style={styles.emptyText}>As atualizações das viagens aparecem aqui</Text>
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
  listContent: { padding: 12, gap: 8 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },

  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  cardUnread: {
    backgroundColor: '#FFFDE7',
    borderLeftWidth: 3,
    borderLeftColor: '#FFD700',
  },
  iconWrap: {
    width: 44,
    height: 44,
    backgroundColor: '#1a1a2e',
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  icon: { fontSize: 22 },
  body: { flex: 1 },
  title: { fontSize: 15, fontWeight: '700', color: '#1a1a2e', marginBottom: 3 },
  bodyText: { fontSize: 13, color: '#555', lineHeight: 18 },
  time: { fontSize: 11, color: '#aaa', marginTop: 5 },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#FFD700',
    marginTop: 4,
    flexShrink: 0,
  },

  empty: { alignItems: 'center' },
  emptyIcon: { fontSize: 56, marginBottom: 16 },
  emptyTitle: { fontSize: 20, fontWeight: 'bold', color: '#1a1a2e', marginBottom: 8 },
  emptyText: { color: '#999', fontSize: 15, textAlign: 'center' },
});
