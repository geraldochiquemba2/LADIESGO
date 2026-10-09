import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Switch,
  ScrollView,
  Alert,
} from 'react-native';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '../../store';
import { logout } from '../../store/slices/authSlice';
import { AppDispatch } from '../../store';

export default function SettingsScreen({ navigation }: any) {
  const dispatch = useDispatch<AppDispatch>();
  const { user } = useSelector((s: RootState) => s.auth);
  const [notifications, setNotifications] = useState(true);
  const [lang, setLang] = useState<'en' | 'ar'>('en');

  const handleLogout = () => {
    Alert.alert('Terminar sessão', 'Tens a certeza que queres sair?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Logout',
        style: 'destructive',
        onPress: () => dispatch(logout()),
      },
    ]);
  };

  return (
    <ScrollView style={styles.container}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Account</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.rowIcon}>👤</Text>
            <View>
              <Text style={styles.rowLabel}>{user?.name || 'User'}</Text>
              <Text style={styles.rowSub}>{user?.role === 'DRIVER' ? 'Driver' : 'Passenger'}</Text>
            </View>
          </View>
          <TouchableOpacity
            style={styles.editBtn}
            onPress={() => navigation.navigate('Profile')}
          >
            <Text style={styles.editBtnText}>Edit Profile</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Preferences</Text>
        <View style={styles.card}>
          <View style={styles.settingRow}>
            <View style={styles.settingLeft}>
              <Text style={styles.settingIcon}>🔔</Text>
              <View>
                <Text style={styles.settingLabel}>Push Notifications</Text>
                <Text style={styles.settingDesc}>Trip updates and offers</Text>
              </View>
            </View>
            <Switch
              value={notifications}
              onValueChange={setNotifications}
              trackColor={{ false: '#ddd', true: '#16a34a' }}
              thumbColor="#fff"
            />
          </View>

          <View style={styles.divider} />

          <View style={styles.settingRow}>
            <View style={styles.settingLeft}>
              <Text style={styles.settingIcon}>🌐</Text>
              <Text style={styles.settingLabel}>Language</Text>
            </View>
            <View style={styles.langToggle}>
              <TouchableOpacity
                style={[styles.langBtn, lang === 'en' && styles.langBtnActive]}
                onPress={() => setLang('en')}
              >
                <Text style={[styles.langBtnText, lang === 'en' && styles.langBtnTextActive]}>EN</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.langBtn, lang === 'ar' && styles.langBtnActive]}
                onPress={() => setLang('ar')}
              >
                <Text style={[styles.langBtnText, lang === 'ar' && styles.langBtnTextActive]}>AR</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Support</Text>
        <View style={styles.card}>
          {[
            { icon: '❓', label: 'Help Center' },
            { icon: '💬', label: 'Contact Support' },
            { icon: '⭐', label: 'Rate the App' },
            { icon: '📄', label: 'Terms of Service' },
            { icon: '🔒', label: 'Privacy Policy' },
          ].map(({ icon, label }) => (
            <TouchableOpacity key={label} style={styles.menuRow}>
              <Text style={styles.menuIcon}>{icon}</Text>
              <Text style={styles.menuLabel}>{label}</Text>
              <Text style={styles.menuArrow}>›</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
        <Text style={styles.logoutText}>🚪 Logout</Text>
      </TouchableOpacity>

      <Text style={styles.version}>TaxiApp v1.0.0</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  section: { marginTop: 24, paddingHorizontal: 16 },
  sectionTitle: { fontSize: 13, color: '#888', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8, marginLeft: 4 },
  card: { backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden', elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4 },

  row: { flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12 },
  rowIcon: { fontSize: 36 },
  rowLabel: { fontSize: 17, fontWeight: '600', color: '#1a1a2e' },
  rowSub: { color: '#888', marginTop: 2 },
  editBtn: { marginHorizontal: 16, marginBottom: 16, borderWidth: 1, borderColor: '#FFD700', borderRadius: 10, padding: 12, alignItems: 'center' },
  editBtnText: { color: '#1a1a2e', fontWeight: '600' },

  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 },
  settingLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  settingIcon: { fontSize: 22 },
  settingLabel: { fontSize: 16, color: '#1a1a2e', fontWeight: '500' },
  settingDesc: { color: '#888', fontSize: 12, marginTop: 2 },
  divider: { height: 1, backgroundColor: '#f0f0f0', marginHorizontal: 16 },

  langToggle: { flexDirection: 'row', backgroundColor: '#f0f0f0', borderRadius: 8, padding: 2 },
  langBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 6 },
  langBtnActive: { backgroundColor: '#FFD700' },
  langBtnText: { color: '#888', fontWeight: '600' },
  langBtnTextActive: { color: '#1a1a2e' },

  menuRow: { flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  menuIcon: { fontSize: 20, marginRight: 12 },
  menuLabel: { flex: 1, fontSize: 16, color: '#1a1a2e' },
  menuArrow: { color: '#ccc', fontSize: 22 },

  logoutBtn: { margin: 16, marginTop: 24, backgroundColor: '#fff', borderRadius: 16, padding: 16, alignItems: 'center', borderWidth: 1.5, borderColor: '#ef4444' },
  logoutText: { color: '#ef4444', fontWeight: 'bold', fontSize: 16 },
  version: { textAlign: 'center', color: '#ccc', fontSize: 13, marginBottom: 40 },
});
