import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
} from 'react-native';
import { driversApi } from '../../services/api';
import { useDispatch } from 'react-redux';
import { logout } from '../../store/slices/authSlice';
import { AppDispatch } from '../../store';
import { socketService } from '../../services/socket';
import { driverGeoSocket } from '../../services/driverGeoSocket';

type Status = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

const statusConfig: Record<Status, { emoji: string; title: string; color: string; desc: string }> = {
  PENDING: {
    emoji: '⏳',
    title: 'Under Review',
    color: '#FF9800',
    desc: 'Your application is being reviewed. This usually takes 1-2 business days.',
  },
  APPROVED: {
    emoji: '✅',
    title: 'Approved!',
    color: '#4CAF50',
    desc: 'Congratulations! Your account is approved. You can now go online and accept trips.',
  },
  REJECTED: {
    emoji: '❌',
    title: 'Not Approved',
    color: '#F44336',
    desc: 'Your application was not approved. Please see the reason below and try again.',
  },
  SUSPENDED: {
    emoji: '🚫',
    title: 'Suspended',
    color: '#9E9E9E',
    desc: 'Your account has been suspended. Please contact support for more information.',
  },
};

export default function PendingApprovalScreen({ navigation }: any) {
  const dispatch = useDispatch<AppDispatch>();
  const [status, setStatus] = useState<Status>('PENDING');
  const [rejectionReason, setRejectionReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const res = await driversApi.getStatus();
      setStatus(res.data.status);
      setRejectionReason(res.data.rejectionReason || null);
      if (res.data.status === 'APPROVED') {
        navigation.replace('DriverHome');
      }
    } catch {
      // driver profile not created yet
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const cfg = statusConfig[status] || statusConfig.PENDING;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        {loading ? (
          <ActivityIndicator size="large" color="#FFD700" style={{ marginTop: 60 }} />
        ) : (
          <>
            <View style={[styles.iconCircle, { backgroundColor: cfg.color + '20' }]}>
              <Text style={styles.icon}>{cfg.emoji}</Text>
            </View>

            <Text style={[styles.title, { color: cfg.color }]}>{cfg.title}</Text>
            <Text style={styles.desc}>{cfg.desc}</Text>

            {rejectionReason && (
              <View style={styles.reasonCard}>
                <Text style={styles.reasonLabel}>Reason</Text>
                <Text style={styles.reasonText}>{rejectionReason}</Text>
              </View>
            )}

            <View style={styles.stepsCard}>
              <Text style={styles.stepsTitle}>Review Process</Text>
              {[
                { done: true, label: 'Application submitted' },
                { done: status !== 'PENDING', label: 'Documents reviewed' },
                { done: status === 'APPROVED', label: 'Account activated' },
              ].map((step, i) => (
                <View key={i} style={styles.step}>
                  <View style={[styles.stepDot, step.done && styles.stepDotDone]}>
                    <Text style={styles.stepDotText}>{step.done ? '✓' : `${i + 1}`}</Text>
                  </View>
                  <Text style={[styles.stepLabel, step.done && styles.stepLabelDone]}>
                    {step.label}
                  </Text>
                </View>
              ))}
            </View>

            {/* Earnings preview while waiting */}
            {status === 'PENDING' && (
              <View style={styles.earningsPreview}>
                <Text style={styles.earningsPreviewTitle}>💰 What you could earn</Text>
                <View style={styles.earningsRow}>
                  <View style={styles.earningsItem}>
                    <Text style={styles.earningsValue}>150 SAR</Text>
                    <Text style={styles.earningsLabel}>Slow day</Text>
                  </View>
                  <View style={[styles.earningsItem, styles.earningsItemHighlight]}>
                    <Text style={[styles.earningsValue, { color: '#FFD700' }]}>280 SAR</Text>
                    <Text style={[styles.earningsLabel, { color: '#aaa' }]}>Avg day</Text>
                  </View>
                  <View style={styles.earningsItem}>
                    <Text style={styles.earningsValue}>400 SAR</Text>
                    <Text style={styles.earningsLabel}>Rush day</Text>
                  </View>
                </View>
                <Text style={styles.earningsNote}>80% of every fare goes directly to you</Text>
              </View>
            )}

            <TouchableOpacity style={styles.refreshBtn} onPress={load}>
              <Text style={styles.refreshText}>🔄 Check Status</Text>
            </TouchableOpacity>

            {status === 'REJECTED' && (
              <TouchableOpacity
                style={styles.reapplyBtn}
                onPress={() => navigation.navigate('DriverRegister')}
              >
                <Text style={styles.reapplyText}>Re-apply</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={styles.logoutBtn}
              onPress={() => {
                driverGeoSocket.stop();
                socketService.logout();
                dispatch(logout());
              }}
            >
              <Text style={styles.logoutText}>Logout</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e' },
  content: { padding: 24, alignItems: 'center', paddingBottom: 48 },

  iconCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 32,
    marginBottom: 20,
  },
  icon: { fontSize: 52 },
  title: { fontSize: 26, fontWeight: 'bold', marginBottom: 10, textAlign: 'center' },
  desc: { color: '#aaa', fontSize: 16, textAlign: 'center', lineHeight: 24, marginBottom: 24 },

  reasonCard: {
    backgroundColor: 'rgba(244,67,54,0.1)',
    borderRadius: 14,
    padding: 16,
    width: '100%',
    marginBottom: 20,
    borderWidth: 1,
    borderColor: 'rgba(244,67,54,0.3)',
  },
  reasonLabel: { color: '#F44336', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  reasonText: { color: '#fff', fontSize: 15 },

  stepsCard: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 16,
    padding: 20,
    width: '100%',
    marginBottom: 24,
  },
  stepsTitle: { color: '#aaa', fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 16 },
  step: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  stepDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#333',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  stepDotDone: { backgroundColor: '#4CAF50' },
  stepDotText: { color: '#fff', fontSize: 12, fontWeight: 'bold' },
  stepLabel: { color: '#666', fontSize: 15 },
  stepLabelDone: { color: '#fff' },

  refreshBtn: {
    backgroundColor: '#FFD700',
    borderRadius: 14,
    padding: 16,
    alignItems: 'center',
    width: '100%',
    marginBottom: 12,
  },
  refreshText: { color: '#1a1a2e', fontWeight: 'bold', fontSize: 16 },

  reapplyBtn: {
    borderWidth: 1.5,
    borderColor: '#FFD700',
    borderRadius: 14,
    padding: 14,
    alignItems: 'center',
    width: '100%',
    marginBottom: 12,
  },
  reapplyText: { color: '#FFD700', fontWeight: '600', fontSize: 16 },

  logoutBtn: {
    padding: 14,
    alignItems: 'center',
    width: '100%',
  },
  logoutText: { color: '#555', fontSize: 15 },

  earningsPreview: {
    backgroundColor: 'rgba(255,215,0,0.08)', borderRadius: 16, padding: 18,
    width: '100%', marginBottom: 20, borderWidth: 1, borderColor: 'rgba(255,215,0,0.2)',
  },
  earningsPreviewTitle: { color: '#FFD700', fontWeight: '700', fontSize: 14, marginBottom: 14, textAlign: 'center' },
  earningsRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  earningsItem: {
    flex: 1, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 12,
    padding: 12, alignItems: 'center',
  },
  earningsItemHighlight: { backgroundColor: '#1a1a2e', borderWidth: 1, borderColor: '#FFD700' },
  earningsValue: { color: '#fff', fontSize: 18, fontWeight: '800', marginBottom: 3 },
  earningsLabel: { color: '#666', fontSize: 11, fontWeight: '600' },
  earningsNote: { color: '#888', fontSize: 12, textAlign: 'center' },
});
