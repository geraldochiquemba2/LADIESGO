import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity, Linking } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

// A app iOS é a SenhorasVa! web (Render) em ecrã cheio: um só código,
// o mesmo produto e marca em todo o lado. Login, viagens, chat, SOS,
// Eliminar conta e Denunciar vivem no site.
const SITE_URL = 'https://ladiesgo.onrender.com/';

export default function App() {
  const webRef = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

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
          <Text style={splash.logo}>🦋</Text>
          <Text style={splash.name}>SenhorasVa!</Text>
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
            <Text style={splash.logo}>🦋</Text>
            <Text style={splash.name}>SenhorasVa!</Text>
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
  logo: { fontSize: 72, marginBottom: 16 },
  name: { fontSize: 36, fontWeight: 'bold', color: '#fff', letterSpacing: 1 },
  tagline: { color: '#e3d0ff', fontSize: 16, marginTop: 6, textAlign: 'center', paddingHorizontal: 32 },
});
