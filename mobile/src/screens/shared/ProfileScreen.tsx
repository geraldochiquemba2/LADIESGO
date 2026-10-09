import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  ScrollView,
  Share,
  Image,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '../../store';
import { logout, setUser } from '../../store/slices/authSlice';
import { usersApi } from '../../services/api';

export default function ProfileScreen() {
  const dispatch = useDispatch<AppDispatch>();
  const { user } = useSelector((s: RootState) => s.auth);
  const [name, setName] = useState(user?.name || '');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [driverInfo, setDriverInfo] = useState<any>(null);
  const [photo, setPhoto] = useState(user?.profilePhoto || '');
  const [uploading, setUploading] = useState(false);

  const changePhoto = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permissão', 'Permite o acesso às fotos para mudar a foto de perfil.');
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.5,
        base64: true,
      });
      if (res.canceled || !res.assets?.[0]?.base64) return;
      const dataUrl = `data:image/jpeg;base64,${res.assets[0].base64}`;
      setUploading(true);
      await usersApi.updateProfile({ profilePhoto: dataUrl });
      setPhoto(dataUrl);
      dispatch(setUser({ ...user, profilePhoto: dataUrl }));
    } catch {
      Alert.alert('Erro', 'Não foi possível guardar a foto.');
    } finally {
      setUploading(false);
    }
  };

  useEffect(() => {
    usersApi.getProfile().then((res) => {
      setName(res.data.name || '');
      setPhoto(res.data.profilePhoto || '');
      if (res.data.driver) setDriverInfo(res.data.driver);
    }).catch(() => {});
  }, []);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await usersApi.updateProfile({ name: name.trim() });
      setEditing(false);
      Alert.alert('Saved', 'Your name has been updated.');
    } catch {
      Alert.alert('Error', 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  };

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

  const roleLabel = user?.role === 'DRIVER' ? 'Motorista' : 'Passageira';
  const roleIcon = user?.role === 'DRIVER' ? '🚗' : '🦋';

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Avatar */}
      <View style={styles.avatarSection}>
        <View style={styles.avatar}>
          {photo ? (
            <Image source={{ uri: photo }} style={styles.avatarImg} />
          ) : (
            <Text style={styles.avatarText}>{roleIcon}</Text>
          )}
        </View>
        <TouchableOpacity style={styles.photoBtn} onPress={changePhoto} disabled={uploading}>
          {uploading ? (
            <ActivityIndicator color="#1a1a2e" size="small" />
          ) : (
            <Text style={styles.photoBtnText}>Mudar foto</Text>
          )}
        </TouchableOpacity>
        <View style={styles.roleBadge}>
          <Text style={styles.roleText}>{roleLabel}</Text>
        </View>
      </View>

      {/* Name section */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Full Name</Text>
        {editing ? (
          <View style={styles.editRow}>
            <TextInput
              style={styles.nameInput}
              value={name}
              onChangeText={setName}
              placeholder="Enter your name"
              autoFocus
            />
            <TouchableOpacity style={styles.saveBtn} onPress={handleSave} disabled={saving}>
              {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.saveBtnText}>Save</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.cancelEditBtn} onPress={() => setEditing(false)}>
              <Text style={styles.cancelEditText}>✕</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity style={styles.nameRow} onPress={() => setEditing(true)}>
            <Text style={styles.nameValue}>{name || 'Tap to add your name'}</Text>
            <Text style={styles.editIcon}>✏️</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Driver stats */}
      {driverInfo && (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Driver Stats</Text>
          <View style={styles.statsRow}>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>⭐ {Number(driverInfo.rating).toFixed(1)}</Text>
              <Text style={styles.statLabel}>Rating</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{driverInfo.totalTrips}</Text>
              <Text style={styles.statLabel}>Trips</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{Number(driverInfo.totalEarnings).toFixed(0)}</Text>
              <Text style={styles.statLabel}>Kz ganhos</Text>
            </View>
          </View>

          {/* Car info */}
          <View style={styles.carCard}>
            <Text style={styles.carIcon}>🚗</Text>
            <View style={styles.carInfo}>
              <Text style={styles.carModel}>
                {[driverInfo.carMake, driverInfo.carModel, driverInfo.carYear].filter(Boolean).join(' ')}
              </Text>
              <Text style={styles.carPlate}>{driverInfo.carPlate}</Text>
              <Text style={styles.carColor}>{driverInfo.carColor}</Text>
            </View>
            <View style={[
              styles.statusBadge,
              driverInfo.status === 'APPROVED' ? styles.statusApproved : styles.statusPending,
            ]}>
              <Text style={styles.statusBadgeText}>
                {driverInfo.status === 'APPROVED' ? 'Approved' : driverInfo.status}
              </Text>
            </View>
          </View>
        </View>
      )}

      {/* Info items */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Account</Text>
        <View style={styles.infoCard}>
          <View style={styles.infoRow}>
            <Text style={styles.infoIcon}>🎭</Text>
            <Text style={styles.infoLabel}>Role</Text>
            <Text style={styles.infoValue}>{roleLabel}</Text>
          </View>
          <View style={styles.infoDivider} />
          <View style={styles.infoRow}>
            <Text style={styles.infoIcon}>✅</Text>
            <Text style={styles.infoLabel}>Status</Text>
            <Text style={[styles.infoValue, { color: '#16a34a' }]}>Active</Text>
          </View>
        </View>
      </View>

      {/* Referral code */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Your Referral Code</Text>
        <TouchableOpacity
          style={styles.referralCard}
          onPress={() => {
            const code = user?.id?.slice(-6).toUpperCase() ?? 'TAXI00';
            Share.share({
              message: `Usa o meu código SenhorasVa ${code} e ganha desconto na 1ª viagem!`,
            });
          }}
        >
          <View style={styles.referralLeft}>
            <Text style={styles.referralCode}>{user?.id?.slice(-6).toUpperCase() ?? 'TAXI00'}</Text>
            <Text style={styles.referralDesc}>Partilha e ganha por cada amiga que viajar</Text>
          </View>
          <Text style={styles.referralCopy}>📤 Share</Text>
        </TouchableOpacity>
        <View style={styles.referralTip}>
          <Text style={styles.referralTipText}>💡 Friends get 20% off first ride when they use your code</Text>
        </View>
      </View>

      {/* Logout */}
      <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
        <Text style={styles.logoutText}>Terminar sessão</Text>
      </TouchableOpacity>

      {/* Apple 5.1.1(v): eliminação de conta obrigatória dentro da app */}
      <TouchableOpacity
        style={styles.deleteBtn}
        onPress={() => {
          Alert.alert(
            'Eliminar conta',
            'Isto apaga o teu nome, foto, telefone e desliga o acesso. As viagens antigas ficam anónimas por segurança. Queres continuar?',
            [
              { text: 'Cancelar', style: 'cancel' },
              {
                text: 'Eliminar',
                style: 'destructive',
                onPress: () => {
                  Alert.alert('Confirmar', 'Toca em Eliminar para confirmar em definitivo.', [
                    { text: 'Voltar', style: 'cancel' },
                    {
                      text: 'Eliminar',
                      style: 'destructive',
                      onPress: async () => {
                        try {
                          await usersApi.deleteMe();
                        } catch {}
                        dispatch(logout());
                      },
                    },
                  ]);
                },
              },
            ],
          );
        }}
      >
        <Text style={styles.deleteText}>Eliminar conta e dados</Text>
      </TouchableOpacity>

      <Text style={styles.version}>SenhorasVa! v1.0 · Luanda, Angola 🇦🇴</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  content: { padding: 20, paddingBottom: 40 },

  avatarSection: { alignItems: 'center', paddingVertical: 28 },
  avatar: {
    width: 90,
    height: 90,
    borderRadius: 45,
    backgroundColor: '#1a1a2e',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 10,
  },
  avatarText: { fontSize: 44 },
  avatarImg: { width: 90, height: 90, borderRadius: 45 },
  photoBtn: {
    marginTop: 10,
    backgroundColor: '#FFD700',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 12,
  },
  photoBtnText: { color: '#1a1a2e', fontWeight: '700', fontSize: 14 },
  roleBadge: {
    backgroundColor: '#FFD700',
    paddingHorizontal: 14,
    paddingVertical: 4,
    borderRadius: 12,
    marginBottom: 6,
  },
  roleText: { color: '#1a1a2e', fontWeight: '700', fontSize: 13 },

  section: { marginBottom: 20 },
  sectionLabel: { color: '#aaa', fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 },

  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
  },
  nameValue: { fontSize: 17, color: '#1a1a2e', fontWeight: '500', flex: 1 },
  editIcon: { fontSize: 18 },

  editRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  nameInput: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    color: '#1a1a2e',
    borderWidth: 1.5,
    borderColor: '#FFD700',
  },
  saveBtn: {
    backgroundColor: '#FFD700',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  saveBtnText: { color: '#1a1a2e', fontWeight: 'bold' },
  cancelEditBtn: {
    backgroundColor: '#f0f0f0',
    borderRadius: 10,
    padding: 14,
  },
  cancelEditText: { color: '#666', fontWeight: 'bold' },

  statsRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  statCard: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    borderRadius: 14,
    padding: 14,
    alignItems: 'center',
  },
  statValue: { color: '#FFD700', fontSize: 20, fontWeight: 'bold', marginBottom: 4 },
  statLabel: { color: '#aaa', fontSize: 11 },

  carCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  carIcon: { fontSize: 32, marginRight: 14 },
  carInfo: { flex: 1 },
  carModel: { fontSize: 16, fontWeight: '600', color: '#1a1a2e' },
  carPlate: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1a1a2e',
    backgroundColor: '#FFD700',
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 5,
    marginTop: 4,
    letterSpacing: 1,
  },
  carColor: { color: '#666', fontSize: 13, marginTop: 3 },
  statusBadge: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  statusApproved: { backgroundColor: '#dcfce7' },
  statusPending: { backgroundColor: '#fef9c3' },
  statusBadgeText: { fontSize: 12, fontWeight: '700', color: '#1a1a2e' },

  infoCard: { backgroundColor: '#fff', borderRadius: 14, overflow: 'hidden' },
  infoRow: { flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12 },
  infoIcon: { fontSize: 20, width: 28 },
  infoLabel: { color: '#666', fontSize: 14, flex: 1 },
  infoValue: { color: '#1a1a2e', fontSize: 14, fontWeight: '600' },
  infoDivider: { height: 1, backgroundColor: '#f0f0f0', marginLeft: 56 },

  referralCard: {
    backgroundColor: '#1a1a2e', borderRadius: 16, padding: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  referralLeft: { flex: 1 },
  referralCode: { color: '#FFD700', fontSize: 26, fontWeight: '900', letterSpacing: 3 },
  referralDesc: { color: '#aaa', fontSize: 12, marginTop: 4 },
  referralCopy: { color: '#FFD700', fontSize: 14, fontWeight: '700' },
  referralTip: {
    backgroundColor: '#FFFDE7', borderRadius: 12, padding: 10, marginTop: 8,
    borderWidth: 1, borderColor: '#FFD700',
  },
  referralTipText: { color: '#1a1a2e', fontSize: 12, fontWeight: '500' },

  logoutBtn: {
    backgroundColor: '#FEE2E2',
    borderRadius: 14,
    padding: 16,
    alignItems: 'center',
    marginBottom: 20,
  },
  logoutText: { color: '#ef4444', fontWeight: 'bold', fontSize: 16 },

  deleteBtn: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    alignItems: 'center',
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  deleteText: { color: '#b91c1c', fontWeight: '600', fontSize: 14 },

  version: { textAlign: 'center', color: '#bbb', fontSize: 12 },
});
