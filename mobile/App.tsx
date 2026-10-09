import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity, Linking, Image } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';

// A app iOS é a LadiesGo! web (Render) em ecrã cheio: um só código,
// o mesmo produto e marca em todo o lado. Login, viagens, chat, SOS,
// Eliminar conta e Denunciar vivem no site. A casca nativa trata de:
// localização, notificações com som, e upload de fotos/documentos.
const SITE_URL = 'https://ladiesgo.onrender.com/';
const API_URL = 'https://ladiesgo.onrender.com/api/v1';
const EAS_PROJECT_ID = 'ec5885e0-c677-4023-b65a-6642fe20f3fd';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Vigia o login no site e entrega o JWT à casca nativa para registar o
// push token — funciona para passageira e motorista (mesma app, mesma
// conta, papéis escolhidos dentro do site).
const AUTH_BRIDGE_JS = `(function(){var s=null;setInterval(function(){try{var t=localStorage.getItem('taxi_token');if(t&&t!==s){s=t;window.ReactNativeWebView.postMessage(JSON.stringify({t:'auth',token:t}));}}catch(e){}},3000);})();`;

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
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

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
      if (msg.t === 'auth' && typeof msg.token === 'string' && msg.token.length > 10) {
        jwtRef.current = msg.token;
        if (pushTokenRef.current) registerPushToken(msg.token, pushTokenRef.current);
      }
    } catch {}
  };

  const onShouldStartLoad = (req: { url: string }) => {
    const url = req.url || '';
    // Chamadas SOS (tel:113/115) e partilhas abrem fora da WebView.
    if (/^(tel:|mailto:|sms:)/i.test(url)) {
      Linking.openURL(url).catch(() => {});
      return false;
    }
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
              setLoading(true);
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
          onLoadStart={() => setLoading(true)}
          onLoadEnd={() => setLoading(false)}
          onError={() => {
            setLoading(false);
            setFailed(true);
          }}
          onHttpError={(e) => {
            if ((e.nativeEvent.statusCode || 0) >= 500) {
              setLoading(false);
              setFailed(true);
            }
          }}
        />
        {loading && !failed && (
          <View style={splash.overlay}>
            <Image source={require('./assets/splash-icon.png')} style={splash.logo} />
            <Text style={splash.name}>LadiesGo!</Text>
            <Text style={splash.tagline}>Mobilidade Feminina Segura</Text>
            <ActivityIndicator color="#fff" style={{ marginTop: 48 }} />
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#61188E' },
  web: { flex: 1, backgroundColor: '#ece8f3' },
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
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#61188E',
    justifyContent: 'center',
    alignItems: 'center',
  },
  logo: { width: 150, height: 150, marginBottom: 12 },
  name: { fontSize: 36, fontWeight: 'bold', color: '#fff', letterSpacing: 1 },
  tagline: { color: '#e3d0ff', fontSize: 16, marginTop: 6, textAlign: 'center', paddingHorizontal: 32 },
});
