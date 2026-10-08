import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Provider, useDispatch } from 'react-redux';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { store } from './src/store';
import { AppDispatch } from './src/store';
import AppNavigator from './src/navigation/AppNavigator';
import { initAuth } from './src/store/slices/authSlice';
import { setCurrentTrip } from './src/store/slices/tripSlice';
import { registerForPushNotifications } from './src/services/notifications';
import { checkForUpdate } from './src/services/updateCheck';
import ConnectingScreen from './src/screens/shared/ConnectingScreen';

// Sessão guardada é restaurada com retries; sem sessão o utilizador
// vê a tela de Login (nome + telemóvel, ou convidado).
const RETRY_DELAYS_MS = [2000, 4000, 8000, 15000];

function Root() {
  const dispatch = useDispatch<AppDispatch>();
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const tryInit = async () => {
      setFailed(false);
      try {
        // Sem sessão guardada vai direto para a tela de Login
        // (sem criar convidado automático).
        const stored = await AsyncStorage.getItem('accessToken');
        if (!stored) {
          if (cancelled) return;
          setReady(true);
          return;
        }
        const action: any = await dispatch(initAuth()).unwrap();
        if (cancelled) return;
        if (action?.activeTrip) {
          dispatch(setCurrentTrip(action.activeTrip));
        }
        registerForPushNotifications();
        setReady(true);
        checkForUpdate(true);
      } catch {
        if (cancelled) return;
        if (attempt < RETRY_DELAYS_MS.length) {
          setTimeout(() => {
            if (!cancelled) setAttempt((a) => a + 1);
          }, RETRY_DELAYS_MS[attempt]);
        } else {
          setFailed(true);
        }
      }
    };

    tryInit();
    return () => { cancelled = true; };
  }, [attempt]);

  if (failed) {
    return <ConnectingScreen onRetry={() => { setFailed(false); setAttempt(0); }} />;
  }

  if (!ready) {
    return (
      <View style={splash.container}>
        <Text style={splash.logo}>🚖</Text>
        <Text style={splash.name}>TaxiApp</Text>
        <Text style={splash.tagline}>Your ride, on demand</Text>
        <ActivityIndicator color="#FFD700" style={{ marginTop: 48 }} />
      </View>
    );
  }

  return (
    <>
      <StatusBar style="dark" />
      <AppNavigator />
    </>
  );
}

export default function App() {
  return (
    <Provider store={store}>
      <Root />
    </Provider>
  );
}

const splash = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    justifyContent: 'center',
    alignItems: 'center',
  },
  logo: { fontSize: 72, marginBottom: 16 },
  name: { fontSize: 36, fontWeight: 'bold', color: '#FFD700', letterSpacing: 1 },
  tagline: { color: '#aaa', fontSize: 16, marginTop: 6 },
});
