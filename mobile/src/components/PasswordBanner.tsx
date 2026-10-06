import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '../store';
import { setUser, logout } from '../store/slices/authSlice';
import { authApi } from '../services/api';

// Banner bloqueante: contas criadas pelo admin entram com a senha padrão e
// têm de definir uma senha própria no primeiro login. Sem dismiss — só
// Sair, para ninguém ficar preso sem rede.
export default function PasswordBanner() {
  const dispatch = useDispatch<AppDispatch>();
  const { user } = useSelector((s: RootState) => s.auth);
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user?.mustChangePassword) return null;

  const save = async () => {
    setError(null);
    if (pw1.length < 4) {
      setError('A senha deve ter pelo menos 4 caracteres.');
      return;
    }
    if (pw1 !== pw2) {
      setError('As senhas não coincidem.');
      return;
    }
    setSaving(true);
    try {
      await authApi.changePassword(pw1);
      dispatch(setUser({ ...user, mustChangePassword: false }));
      setPw1('');
      setPw2('');
    } catch (e: any) {
      setError(e?.response?.data?.message || 'Falhou. Tenta de novo.');
    } finally {
      setSaving(false);
    }
  };

  const quit = () => {
    Alert.alert('Sair', 'Queres terminar a sessão?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Sair', style: 'destructive', onPress: () => dispatch(logout()) },
    ]);
  };

  return (
    <Modal visible transparent animationType="fade">
      <View style={styles.backdrop}>
        <View style={styles.box}>
          <Text style={styles.title}>Define a tua senha</Text>
          <Text style={styles.sub}>
            Entraste com a senha padrão. Escolhe uma senha só tua para continuar.
          </Text>
          <TextInput
            style={styles.input}
            placeholder="Nova senha (mín. 4)"
            placeholderTextColor="#8a68b8"
            value={pw1}
            onChangeText={setPw1}
            secureTextEntry
          />
          <TextInput
            style={styles.input}
            placeholder="Repete a nova senha"
            placeholderTextColor="#8a68b8"
            value={pw2}
            onChangeText={setPw2}
            secureTextEntry
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <TouchableOpacity style={styles.cta} onPress={save} disabled={saving}>
            {saving ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.ctaText}>Guardar senha</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity onPress={quit}>
            <Text style={styles.quit}>Sair</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(20,0,50,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  box: {
    backgroundColor: '#fdf6ff',
    borderRadius: 20,
    padding: 22,
    width: '100%',
    maxWidth: 380,
  },
  title: { fontSize: 21, fontWeight: '800', color: '#2a0c58' },
  sub: { fontSize: 13.5, color: '#6b4a9a', marginTop: 4, marginBottom: 12, lineHeight: 19 },
  input: {
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: '#e3d0f8',
    borderRadius: 14,
    padding: 13,
    fontSize: 16,
    color: '#2a0c58',
    marginBottom: 10,
  },
  error: {
    color: '#c2185b',
    backgroundColor: '#ffe3ef',
    borderRadius: 12,
    padding: 10,
    marginBottom: 10,
    textAlign: 'center',
    fontSize: 13.5,
    fontWeight: '600',
  },
  cta: {
    backgroundColor: '#6a2bd6',
    borderRadius: 14,
    padding: 15,
    alignItems: 'center',
    marginTop: 2,
  },
  ctaText: { color: '#fff', fontWeight: '800', fontSize: 17 },
  quit: { color: '#6a2bd6', textAlign: 'center', fontSize: 14, fontWeight: '600', padding: 12 },
});
