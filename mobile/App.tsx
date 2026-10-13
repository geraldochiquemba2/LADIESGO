import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity, Linking } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import './src/services/bgLocation';
import { BG_LOCATION_TASK } from './src/services/bgLocation';

// A app iOS é a LadiesGo! web (Cloudflare Pages) em ecrã cheio: um só código,
// o mesmo produto e marca em todo o lado. Login, viagens, chat, SOS,
// Eliminar conta e Denunciar vivem no site. A casca nativa trata de:
// localização, notificações com som, e upload de fotos/documentos.
// ?v= rebenta a cache da WebView: sem isto o iOS servia o HTML antigo
// e as melhorias do mapa não apareciam. Aumenta a cada deploy do site.
const SITE_URL = 'https://ladiesgo.pages.dev/ladiesgo?v=20261013';
const API_URL = 'https://ladiesgo-api.ladiesgo-ao.workers.dev/api/v1';
const EAS_PROJECT_ID = 'ec5885e0-c677-4023-b65a-6642fe20f3fd';

Notifications.setNotificationHandler({
  // Dentro da app: sem banner/som do sistema (a home já toca o alerta).
  // Fora da app (fundo/fechada): o iOS apresenta tudo na mesma.
  handleNotification: async () => ({
    shouldShowAlert: false,
    shouldShowBanner: false,
    shouldShowList: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

// Vigia o login E o estado (viagem ativa / online) no site e entrega tudo
// à casca nativa: regista o push token e alimenta a task de GPS em fundo.
// Funciona para passageira e motorista (mesma app, mesma conta, papéis
// escolhidos dentro do site).
const AUTH_BRIDGE_JS = `(function(){var s='';setInterval(function(){try{var t=localStorage.getItem('taxi_token')||'';var u=null;try{u=JSON.parse(localStorage.getItem('taxi_user')||'null')}catch(e){}var tid=null;try{tid=localStorage.getItem('lg_trip')||localStorage.getItem('lg_mtrip')}catch(e){}var on=false;try{on=localStorage.getItem('lg_online')==='1'}catch(e){}var k=t+'|'+(u&&u.id||'')+'|'+(u&&u.role||'')+'|'+(tid||'')+'|'+(on?'1':'0');if(k!==s){s=k;window.ReactNativeWebView.postMessage(JSON.stringify({t:'state',token:t||null,user:u,tripId:tid,online:on}));}}catch(e){}},3000);})();`;

async function registerPushToken(jwt: string, expoToken: string) {
  try {
    await fetch(API_URL + '/users/profile', {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fcmToken: expoToken }),
    });
  } catch {
    // Falha de rede — o próximo login torna a tentar via bridge.
  }
}

export default function App() {
  const webRef = useRef<WebView>(null);
  const jwtRef = useRef<string | null>(null);
  const pushTokenRef = useRef<string | null>(null);
  const loadTimer = useRef<any>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const endLoading = () => {
    try { if (loadTimer.current) clearTimeout(loadTimer.current); } catch {}
    loadTimer.current = null;
    setLoading(false);
  };
  const beginLoading = () => {
    setLoading(true);
    try { if (loadTimer.current) clearTimeout(loadTimer.current); } catch {}
    // Rede de segurança: nenhum load fica a girar para sempre.
    loadTimer.current = setTimeout(() => setLoading(false), 25000);
  };

  // Permissões NATIVAS ao abrir (uma vez): localização + notificações com som.
  useEffect(() => {
    (async () => {
      try {
        await Location.requestForegroundPermissionsAsync();
      } catch {}
      try {
        const perm = await Notifications.requestPermissionsAsync({
          ios: { allowAlert: true, allowBadge: true, allowSound: true },
        });
        if (!perm.granted) return;
        const pt = await Notifications.getExpoPushTokenAsync({ projectId: EAS_PROJECT_ID });
        pushTokenRef.current = pt.data;
        if (jwtRef.current) registerPushToken(jwtRef.current, pt.data);
      } catch {}
    })();
  }, []);

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data || '{}');
      if (msg.t === 'need-gps') {
        // O site pede autorização nativa (1ª negação): o sistema mostra o
        // prompt se ainda for permitido; depois tenta o GPS do site de novo.
        // Se já estiver negado em definitivo, o site mostra o tutorial.
        (async () => {
          try { await Location.requestForegroundPermissionsAsync(); } catch {}
          try { webRef.current?.injectJavaScript('try{window.__gpsAsked=true;locateMe()}catch(e){}true;'); } catch {}
        })();
        return;
      }
      if (msg.t === 'open-settings') {
        // Negado em definitivo: o iOS nunca volta a perguntar — levar
        // direta às Definições da app é o único caminho.
        try { Linking.openSettings(); } catch {}
        return;
      }
      const token = typeof msg.token === 'string' && msg.token.length > 10 ? msg.token : null;
      if ((msg.t === 'auth' || msg.t === 'state') && (token || msg.t === 'state')) {
        const u = (msg.user || {}) as any;
        const state = {
          jwt: token,
          userId: u.id || null,
          role: u.role || null,
          name: u.name || u.phone || null,
          tripId: msg.tripId || null,
          online: !!msg.online,
        };
        jwtRef.current = token;
        AsyncStorage.setItem('lg_bg_state', JSON.stringify(state)).catch(() => {});
        if (token && pushTokenRef.current) registerPushToken(token, pushTokenRef.current);
        // Apple (background location): só liga o GPS em fundo quando faz
        // falta — motorista online ou viagem ativa. Passageira sem viagem
        // não precisa de fundo; poupa bateria e cumpre a guideline 5.1.1.
        ensureBgTask(state);
      }
    } catch {}
  };

  // GPS em fundo SÓ quando necessário (Apple guideline 5.1.1 + background
  // location): motorista online OU viagem ativa (passageira a partilhar /
  // a ser seguida). Sem sessão ou passageira idle: desliga para poupar
  // bateria. O pedido "Sempre" só acontece neste contexto, nunca no login.
  const ensureBgTask = async (state: { jwt: string | null; role: string | null; tripId: string | null; online: boolean }) => {
    try {
      const started = await Location.hasStartedLocationUpdatesAsync(BG_LOCATION_TASK);
      const needsBackground = !!state.jwt && (state.online || !!state.tripId) && (state.role === 'DRIVER' || !!state.tripId);
      if (!needsBackground) {
        if (started) await Location.stopLocationUpdatesAsync(BG_LOCATION_TASK);
        return;
      }
      if (started) return;
      const fg = await Location.requestForegroundPermissionsAsync();
      if (fg.status !== 'granted') return;
      try {
        const bg = await Location.requestBackgroundPermissionsAsync();
        if (bg.status !== 'granted') return;
      } catch {
        return;
      }
      await Location.startLocationUpdatesAsync(BG_LOCATION_TASK, {
        accuracy: Location.Accuracy.High,
        timeInterval: 8000,
        distanceInterval: 15,
        pausesUpdatesAutomatically: false,
        activityType: Location.ActivityType.AutomotiveNavigation,
        showsBackgroundLocationIndicator: true,
        foregroundService: {
          notificationTitle: 'LadiesGo!',
          notificationBody: 'Partilha de posição ativa para a tua segurança.',
          notificationColor: '#61188E',
        },
      });
    } catch {}
  };

  const onShouldStartLoad = (req: { url: string }) => {
    const url = req.url || '';
    // Chamadas SOS (tel:113/115) e partilhas abrem fora da WebView.
    if (/^(tel:|mailto:|sms:)/i.test(url)) {
      Linking.openURL(url).catch(() => {});
      return false;
    }
    // Apps de navegação (Waze/Google/Apple Maps) e qualquer site externo
    // abrem na app própria: dentro da WebView prendiam o loading no roxo.
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        if (u.hostname === 'ladiesgo.pages.dev') return true;
        Linking.openURL(url).catch(() => {});
        return false;
      }
    } catch {}
    return true;
  };

  if (failed) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={splash.container}>
          <StatusBar style="light" />
          <Text style={splash.name}>LadiesGo!</Text>
          <Text style={splash.tagline}>Sem ligação. Verifica a internet.</Text>
          <TouchableOpacity
            style={styles.retry}
            onPress={() => {
              setFailed(false);
              beginLoading();
              webRef.current?.reload();
            }}
          >
            <Text style={styles.retryText}>Tentar de novo</Text>
          </TouchableOpacity>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <WebView
          ref={webRef}
          source={{ uri: SITE_URL }}
          style={styles.web}
          javaScriptEnabled
          domStorageEnabled
          geolocationEnabled
          mediaPlaybackRequiresUserAction={false}
          allowsInlineMediaPlayback
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          allowsBackForwardNavigationGestures
          injectedJavaScript={AUTH_BRIDGE_JS}
          onMessage={onMessage}
          onShouldStartLoadWithRequest={onShouldStartLoad}
          onLoadStart={beginLoading}
          onLoadEnd={() => {
            // Esconde com atraso: sem isto há um flash branco entre o
            // fim do load e a primeira pintura da página (fundo roxo).
            setTimeout(endLoading, 700);
          }}
          onError={() => {
            endLoading();
            setFailed(true);
          }}
          onHttpError={(e) => {
            if ((e.nativeEvent.statusCode || 0) >= 500) {
              endLoading();
              setFailed(true);
            }
          }}
        />
        {loading && !failed && (
          <View style={splash.overlay}>
            <ActivityIndicator color="#fff" size="large" />
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#61188E' },
  web: { flex: 1, backgroundColor: '#61188E' },
  retry: {
    marginTop: 28,
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingHorizontal: 28,
    paddingVertical: 14,
  },
  retryText: { color: '#5b21c9', fontWeight: '800', fontSize: 16 },
});

const splash = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#61188E',
    justifyContent: 'center',
    alignItems: 'center',
  },
  overlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#61188E',
    justifyContent: 'center',
    alignItems: 'center',
  },
  logo: { width: 150, height: 150, marginBottom: 12 },
  name: { fontSize: 36, fontWeight: 'bold', color: '#fff', letterSpacing: 1 },
  tagline: { color: '#e3d0ff', fontSize: 16, marginTop: 6, textAlign: 'center', paddingHorizontal: 32 },
});
