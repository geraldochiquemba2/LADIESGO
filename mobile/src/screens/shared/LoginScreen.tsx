import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Alert,
  Animated,
  Dimensions,
  Easing,
} from 'react-native';
import { useDispatch } from 'react-redux';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppDispatch } from '../../store';
import { initAuth, setSession } from '../../store/slices/authSlice';
import { authApi } from '../../services/api';

// Números angolanos: +244 9XX XXX XXX
// Unitel 92/93 · Movicel 91 · Africell 94/95/99
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  const local = digits.startsWith('244') ? digits.slice(3) : digits;
  if (/^9[123459]\d{7}$/.test(local)) return `+244${local}`;
  return null;
}

const { width: SCREEN_W } = Dimensions.get('window');

function AnimatedScene({ onSos }: { onSos: () => void }) {
  const taxiX = useRef(new Animated.Value(0)).current;
  const bob = useRef(new Animated.Value(0)).current;
  const twinkle = useRef(new Animated.Value(0)).current;
  const float = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const drive = Animated.loop(
      Animated.timing(taxiX, { toValue: 1, duration: 9000, easing: Easing.linear, useNativeDriver: true }),
    );
    const bouncing = Animated.loop(
      Animated.sequence([
        Animated.timing(bob, { toValue: 1, duration: 450, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(bob, { toValue: 0, duration: 450, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    const stars = Animated.loop(
      Animated.sequence([
        Animated.timing(twinkle, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(twinkle, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    const hovering = Animated.loop(
      Animated.sequence([
        Animated.timing(float, { toValue: 1, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(float, { toValue: 0, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    drive.start();
    bouncing.start();
    stars.start();
    hovering.start();
    return () => {
      drive.stop();
      bouncing.stop();
      stars.stop();
      hovering.stop();
    };
  }, [taxiX, bob, twinkle, float]);

  const taxiLeft = taxiX.interpolate({ inputRange: [0, 1], outputRange: [-90, SCREEN_W + 20] });
  const taxiBob = bob.interpolate({ inputRange: [0, 1], outputRange: [0, -4] });
  const starOpacity = twinkle.interpolate({ inputRange: [0, 1], outputRange: [0.25, 1] });
  const flyY = float.interpolate({ inputRange: [0, 1], outputRange: [0, -12] });

  return (
    <View style={styles.scene}>
      <TouchableOpacity style={styles.sos} onPress={onSos}>
        <Text style={styles.sosText}>SOS</Text>
      </TouchableOpacity>
      <Text style={styles.moon}>🌙</Text>
      <Animated.Text style={[styles.star, { top: 60, left: 40, opacity: starOpacity }]}>✦</Animated.Text>
      <Animated.Text style={[styles.star, { top: 96, left: 150, opacity: starOpacity }]}>✦</Animated.Text>
      <Animated.Text style={[styles.star, { top: 48, left: 260, opacity: starOpacity }]}>✦</Animated.Text>
      <Animated.Text style={[styles.star, { top: 120, left: 320, opacity: starOpacity }]}>✦</Animated.Text>
      <Animated.View style={{ transform: [{ translateY: flyY }] }}>
        <Text style={styles.butterfly}>🦋</Text>
      </Animated.View>
      <Text style={styles.brand}>LadiesGo!</Text>
      <Text style={styles.tagline}>Mobilidade Feminina Segura</Text>
      <Animated.Text
        style={[styles.taxi, { transform: [{ translateX: taxiLeft }, { translateY: taxiBob }] }]}
      >
        🚕
      </Animated.Text>
      <View style={styles.road} />
    </View>
  );
}

export default function LoginScreen() {
  const dispatch = useDispatch<AppDispatch>();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ageOk, setAgeOk] = useState(false);

  const doLogin = async (asGuest: boolean) => {
    setError(null);
    const cleanName = name.trim();

    if (!asGuest) {
      if (cleanName.length < 2) {
        setError('Escreve o teu nome (mín. 2 letras).');
        return;
      }
      if (!normalizePhone(phone)) {
        setError('Escreve um número angolano válido: 9XX XXX XXX (Unitel, Movicel ou Africell).');
        return;
      }
      if (!ageOk) {
        setError('Para usar a LadiesGo! tens de confirmar que tens 18 anos ou mais.');
        return;
      }
    }

    setLoading(true);
    try {
      await dispatch(initAuth(asGuest ? undefined : cleanName || undefined)).unwrap();
      const normalized = normalizePhone(phone);
      if (normalized) {
        await AsyncStorage.setItem('userPhone', normalized);
      } else {
        await AsyncStorage.removeItem('userPhone');
      }
    } catch {
      setError('Sem ligação ao servidor. Verifica a internet e tenta de novo.');
    } finally {
      setLoading(false);
    }
  };

  const doPasswordLogin = async () => {
    setError(null);
    const normalized = normalizePhone(phone);
    if (!normalized) {
      setError('Escreve um número angolano válido: 9XX XXX XXX (Unitel, Movicel ou Africell).');
      return;
    }
    if (password.length < 4) {
      setError('A senha deve ter pelo menos 4 caracteres.');
      return;
    }
    setLoading(true);
    try {
      const res = await authApi.login(normalized, password);
      await AsyncStorage.setItem('accessToken', res.data.accessToken);
      await AsyncStorage.setItem('userPhone', normalized);
      dispatch(setSession({ user: res.data.user, accessToken: res.data.accessToken }));
    } catch (e: any) {
      setError(e?.response?.data?.message || 'Número ou senha incorretos.');
    } finally {
      setLoading(false);
    }
  };

  const showSos = () => {
    Alert.alert(
      '🛡 Centro de segurança',
      'Escolhe uma ação.',
      [
        { text: 'Ligar para a emergência', onPress: () => {} },
        { text: 'Alertar contactos', onPress: () => {} },
        { text: 'Estou bem, voltar', style: 'cancel' },
      ],
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <AnimatedScene onSos={showSos} />
      <ScrollView contentContainerStyle={styles.card} keyboardShouldPersistTaps="handled">
        <Text style={styles.cardTitle}>Bem-vinda 💜</Text>
        <Text style={styles.cardSub}>Só motoristas mulheres verificadas</Text>

        <Text style={styles.label}>Nome</Text>
        <TextInput
          style={styles.input}
          placeholder="O teu nome"
          placeholderTextColor="#8a68b8"
          value={name}
          onChangeText={setName}
          autoCapitalize="words"
          returnKeyType="next"
        />

        <Text style={styles.label}>Telemóvel (Angola)</Text>
        <View style={styles.phoneRow}>
          <Text style={styles.prefix}>+244</Text>
          <TextInput
            style={[styles.input, styles.phoneInput]}
            placeholder="9XX XXX XXX"
            placeholderTextColor="#8a68b8"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            maxLength={13}
            returnKeyType="done"
          />
        </View>
        <Text style={styles.hint}>Número angolano obrigatório — o código SMS (OTP) chega na próxima versão.</Text>

        <Text style={styles.label}>Senha (se tens conta)</Text>
        <TextInput
          style={styles.input}
          placeholder="A tua senha"
          placeholderTextColor="#8a68b8"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          returnKeyType="done"
        />
        <TouchableOpacity
          style={[styles.cta, styles.passCta, loading && styles.btnDisabled]}
          onPress={doPasswordLogin}
          disabled={loading}
        >
          {loading
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.ctaText}>Entrar com senha</Text>}
        </TouchableOpacity>

        <TouchableOpacity style={styles.ageRow} onPress={() => setAgeOk((v) => !v)}>
          <View style={[styles.checkbox, ageOk && styles.checkboxOn]}>
            {ageOk ? <Text style={styles.checkMark}>✓</Text> : null}
          </View>
          <Text style={styles.ageText}>Confirmo que tenho 18 anos ou mais e aceito a Política de Privacidade</Text>
        </TouchableOpacity>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.cta, loading && styles.btnDisabled]}
          onPress={() => doLogin(false)}
          disabled={loading}
        >
          {loading
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.ctaText}>Entrar →</Text>}
        </TouchableOpacity>

        <TouchableOpacity onPress={() => doLogin(true)} disabled={loading}>
          <Text style={styles.guestLink}>Continuar como convidada</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1b0a3c' },
  scene: {
    height: 300,
    alignItems: 'center',
    justifyContent: 'flex-end',
    backgroundColor: '#1b0a3c',
    overflow: 'hidden',
    paddingBottom: 34,
  },
  sos: {
    position: 'absolute',
    top: 50,
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#ff3d7f',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
  },
  sosText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  moon: { position: 'absolute', top: 44, left: 24, fontSize: 30, opacity: 0.9 },
  star: { position: 'absolute', color: '#fff', fontSize: 14 },
  butterfly: { fontSize: 54, marginBottom: 2 },
  brand: { fontSize: 42, fontWeight: '800', color: '#fff' },
  tagline: { color: '#e3d0ff', fontSize: 14, marginTop: 2, marginBottom: 8 },
  taxi: { fontSize: 52, position: 'absolute', bottom: 22, left: 0 },
  road: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 22, backgroundColor: '#22093f', borderTopWidth: 2, borderTopColor: '#6a3bb5' },
  card: {
    backgroundColor: '#fdf6ff',
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    padding: 20,
    paddingBottom: 32,
    flexGrow: 1,
  },
  cardTitle: { fontSize: 21, fontWeight: '800', color: '#2a0c58' },
  cardSub: { fontSize: 13.5, color: '#6b4a9a', fontWeight: '500', marginTop: 2, marginBottom: 12 },
  label: { color: '#6a2bd6', fontSize: 13, fontWeight: '700', marginBottom: 6, marginTop: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: {
    backgroundColor: '#fff', borderWidth: 2, borderColor: '#e3d0f8',
    borderRadius: 16, padding: 13, fontSize: 16, color: '#2a0c58', fontWeight: '700',
  },
  phoneRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  prefix: {
    color: '#6a2bd6', fontWeight: '800', fontSize: 17,
    backgroundColor: '#f3e6ff', borderRadius: 16, paddingVertical: 13, paddingHorizontal: 14,
  },
  phoneInput: { flex: 1 },
  hint: { color: '#8a68b8', fontSize: 12, marginTop: 6, marginBottom: 16 },
  error: {
    color: '#c2185b', backgroundColor: '#ffe3ef', borderRadius: 12,
    padding: 12, marginBottom: 16, textAlign: 'center', fontSize: 14, fontWeight: '600',
  },
  cta: {
    backgroundColor: '#6a2bd6', borderRadius: 16, padding: 16,
    alignItems: 'center', marginBottom: 12,
  },
  btnDisabled: { opacity: 0.6 },
  ctaText: { color: '#fff', fontWeight: '800', fontSize: 18 },
  passCta: { marginTop: 10 },
  guestLink: { color: '#6a2bd6', textAlign: 'center', fontSize: 15, fontWeight: '600', padding: 8 },
  ageRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 12, marginBottom: 4 },
  checkbox: {
    width: 24, height: 24, borderRadius: 8, borderWidth: 2, borderColor: '#6a2bd6',
    backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', marginTop: 1,
  },
  checkboxOn: { backgroundColor: '#6a2bd6' },
  checkMark: { color: '#fff', fontWeight: '800', fontSize: 14 },
  ageText: { flex: 1, color: '#4a2a7a', fontSize: 13, lineHeight: 18 },
});
