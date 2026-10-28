import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, Linking, AppState } from 'react-native';
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
const SITE_URL = 'https://ladiesgo.pages.dev/ladiesgo?v=20261027';
// >> LADIESGO 2026-10-17: API na CONTA CLOUDFLARE NOVA (ladiesgo-angola); a conta antiga ladiesgo-ao esgotou a quota de Workers (erro 1027). VOLTAR AO NORMAL = trocar "ladiesgo-api.rererererererere670.workers.dev" por "ladiesgo-api.rererererererere670.workers.dev" e gerar novo build. Ver cloudflare/README.md
const API_URL = 'https://ladiesgo-api.rererererererere670.workers.dev/api/v1';
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

// GPS NATIVO -> WebView: o WKWebView mostrava em inglês o aviso
// "This website will use your precise location...". Aqui o site deixa de
// pedir geolocalização ao WebView e passa a usar o GPS da app, cujo pedido
// de permissão está em português em app.json.
const GEO_BRIDGE_JS = `(function(){
  if(window.__lgGeoBridge)return;
  window.__lgGeoBridge=true;
  var seq=0,cbs={};
  function post(o){try{window.ReactNativeWebView.postMessage(JSON.stringify(o))}catch(e){}}
  var geo={
    getCurrentPosition:function(ok,bad,opts){
      var id='g'+(++seq);
      cbs[id]={ok:ok,bad:bad,watch:false};
      post({t:'gps-get',id:id,options:opts||{}});
    },
    watchPosition:function(ok,bad,opts){
      var id='w'+(++seq);
      cbs[id]={ok:ok,bad:bad,watch:true};
      post({t:'gps-watch',id:id,options:opts||{}});
      return id;
    },
    clearWatch:function(id){
      if(!id)return;
      delete cbs[id];
      post({t:'gps-clear',id:String(id)});
    }
  };
  window.__lgGeoDispatch=function(id,kind,p){
    var cb=cbs[id];
    if(!cb)return;
    try{
      if(kind==='pos'){
        var c=(p&&p.coords)||{};
        cb.ok&&cb.ok({
          coords:{
            latitude:c.latitude,
            longitude:c.longitude,
            accuracy:c.accuracy,
            altitude:c.altitude,
            altitudeAccuracy:c.altitudeAccuracy,
            heading:c.heading,
            speed:c.speed
          },
          timestamp:(p&&p.timestamp)||Date.now()
        });
        if(!cb.watch)delete cbs[id];
      }else{
        var e={
          code:(p&&p.code)||2,
          message:(p&&p.message)||'Localização indisponível',
          PERMISSION_DENIED:1,
          POSITION_UNAVAILABLE:2,
          TIMEOUT:3
        };
        cb.bad&&cb.bad(e);
        if(!cb.watch)delete cbs[id];
      }
    }catch(e){}
  };
  try{
    Object.defineProperty(navigator,'geolocation',{value:geo,configurable:true});
  }catch(e){
    try{
      Object.defineProperty(Object.getPrototypeOf(navigator),'geolocation',{get:function(){return geo},configurable:true});
    }catch(_){}
  }
})();`;

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
  const bgAtRef = useRef<number>(0);
  const pingTimer = useRef<any>(null);
  const loadRetry = useRef(0);
  const geoSubs = useRef<Record<string, Location.LocationSubscription>>({});
  const geoCancelled = useRef<Set<string>>(new Set());
  const geoGen = useRef(0);
  const headingSub = useRef<Location.LocationSubscription | null>(null);
  const headingAt = useRef(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const endLoading = () => {
    try { if (loadTimer.current) clearTimeout(loadTimer.current); } catch {}
    loadTimer.current = null;
    loadRetry.current = 0;
    setLoading(false);
  };
  const beginLoading = () => {
    setLoading(true);
    try { if (loadTimer.current) clearTimeout(loadTimer.current); } catch {}
    // Rede de segurança: nenhum load fica a girar para sempre. Se o load
    // nunca termina (ecra lilas sem erro), recarrega uma vez antes de desistir.
    loadTimer.current = setTimeout(() => {
      loadTimer.current = null;
      try { if (AppState.currentState !== 'active') { setLoading(false); return; } } catch {}
      if (loadRetry.current < 1) {
        loadRetry.current++;
        reloadWeb();
        return;
      }
      setLoading(false);
    }, 25000);
  };
  const reloadWeb = () => {
    try { beginLoading(); } catch {}
    try { webRef.current?.reload(); } catch {}
  };

  const inject = (code: string) => {
    try { webRef.current?.injectJavaScript(code + ';true;'); } catch {}
  };
  const geoReply = (id: string, kind: 'pos' | 'err', payload: any) => {
    inject('try{window.__lgGeoDispatch(' + JSON.stringify(String(id)) + ',' + JSON.stringify(kind) + ',' + JSON.stringify(payload) + ')}catch(e){}');
  };
  const geoErrCode = (e: any) => /permission|denied|authorized|negad/i.test(String((e && e.message) || e || '')) ? 1 : 2;
  // Bússola NATIVA -> WebView. O WKWebView/Android WebView não entrega
  // deviceorientation de forma fiável, por isso a rota ficava sem rumo.
  // Aqui injeta-se o heading real como um evento deviceorientation.
  const startHeadingWatch = async () => {
    if (headingSub.current) return;
    try {
      const perm = await Location.getForegroundPermissionsAsync();
      if (!perm.granted) return;
      headingSub.current = await Location.watchHeadingAsync((h) => {
        const now = Date.now();
        if (now - headingAt.current < 400) return;
        headingAt.current = now;
        let v = h && Number.isFinite(h.trueHeading) && h.trueHeading >= 0 ? h.trueHeading : h && h.magHeading;
        if (!Number.isFinite(v)) return;
        v = ((Math.round(v) % 360) + 360) % 360;
        inject(
          'try{var h=' + v + ';window.__nativeHeading=h;window.__nativeHeadingAt=Date.now();' +
          "var e=new Event('deviceorientation');e.alpha=360-h;e.webkitCompassHeading=h;e.absolute=true;window.dispatchEvent(e)}catch(e){}"
        );
      });
    } catch {
      headingSub.current = null;
    }
  };
  const clearGeoSubs = () => {
    geoGen.current++;
    geoCancelled.current.clear();
    Object.keys(geoSubs.current).forEach((key) => {
      try { geoSubs.current[key].remove(); } catch {}
      delete geoSubs.current[key];
    });
  };
  const clearGeoWatch = (id: string) => {
    const key = String(id);
    geoCancelled.current.add(key);
    const sub = geoSubs.current[key];
    if (sub) {
      try { sub.remove(); } catch {}
      delete geoSubs.current[key];
    }
  };
  const handleGeoGet = async (id: string, options: any) => {
    const gen = geoGen.current;
    try {
      let perm = await Location.getForegroundPermissionsAsync();
      if (!perm.granted) perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) {
        if (gen === geoGen.current) geoReply(id, 'err', { code: 1, message: 'Permissão de localização negada' });
        return;
      }
      if (!(await Location.hasServicesEnabledAsync())) {
        if (gen === geoGen.current) geoReply(id, 'err', { code: 2, message: 'Serviços de localização desligados' });
        return;
      }
      const accuracy = options && options.enableHighAccuracy ? Location.Accuracy.High : Location.Accuracy.Balanced;
      const timeoutMs = Math.max(4000, Math.min(30000, Number(options && options.timeout) || 12000));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject({ __lgTimeout: true }), timeoutMs);
      });
      let loc: Location.LocationObject;
      try {
        loc = await Promise.race([
          Location.getCurrentPositionAsync({ accuracy, mayShowUserSettingsDialog: true }),
          timeout,
        ]);
      } catch (e: any) {
        if (gen === geoGen.current) {
          if (e && e.__lgTimeout) geoReply(id, 'err', { code: 3, message: 'Tempo esgotado a obter GPS' });
          else geoReply(id, 'err', { code: geoErrCode(e), message: String((e && e.message) || e || 'GPS indisponível') });
        }
        return;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (gen === geoGen.current) geoReply(id, 'pos', { coords: loc.coords, timestamp: loc.timestamp });
    } catch (e: any) {
      if (gen === geoGen.current) geoReply(id, 'err', { code: geoErrCode(e), message: String((e && e.message) || e || 'GPS indisponível') });
    }
  };
  const handleGeoWatch = async (id: string, options: any) => {
    const key = String(id);
    const old = geoSubs.current[key];
    if (old) {
      try { old.remove(); } catch {}
      delete geoSubs.current[key];
    }
    geoCancelled.current.delete(key);
    const gen = geoGen.current;
    try {
      let perm = await Location.getForegroundPermissionsAsync();
      if (!perm.granted) perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) {
        if (gen === geoGen.current) geoReply(key, 'err', { code: 1, message: 'Permissão de localização negada' });
        return;
      }
      if (!(await Location.hasServicesEnabledAsync())) {
        if (gen === geoGen.current) geoReply(key, 'err', { code: 2, message: 'Serviços de localização desligados' });
        return;
      }
      const accuracy = options && options.enableHighAccuracy ? Location.Accuracy.High : Location.Accuracy.Balanced;
      const sub = await Location.watchPositionAsync(
        { accuracy, timeInterval: 4000, distanceInterval: 5, mayShowUserSettingsDialog: true },
        (loc) => {
          if (gen === geoGen.current) geoReply(key, 'pos', { coords: loc.coords, timestamp: loc.timestamp });
        },
        (message) => {
          if (gen === geoGen.current) {
            geoReply(key, 'err', {
              code: /permission|denied|authorized|negad/i.test(String(message)) ? 1 : 2,
              message: String(message),
            });
          }
        },
      );
      if (gen !== geoGen.current || geoCancelled.current.has(key)) {
        try { sub.remove(); } catch {}
        return;
      }
      geoSubs.current[key] = sub;
    } catch (e: any) {
      if (gen === geoGen.current) geoReply(key, 'err', { code: geoErrCode(e), message: String((e && e.message) || e || 'GPS indisponível') });
    }
  };

  // Permissões NATIVAS ao abrir (uma vez): localização + notificações com som.
  useEffect(() => {
    (async () => {
      try {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (perm.granted) startHeadingWatch();
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

  // Ao voltar do fundo depois de muito tempo o iOS pode matar o processo da
  // WebView (ecrã lilás/vazio, só se resolve fechando a app). Aqui procura-se
  // viver: se a página não responder, recarrega sozinha.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'background' || st === 'inactive') {
        if (!bgAtRef.current) bgAtRef.current = Date.now();
        return;
      }
      if (st !== 'active') return;
      const away = bgAtRef.current ? Date.now() - bgAtRef.current : 0;
      bgAtRef.current = 0;
      if (away < 20000) return;
      try { if (pingTimer.current) clearTimeout(pingTimer.current); } catch {}
      try {
        webRef.current?.injectJavaScript("try{window.ReactNativeWebView.postMessage(JSON.stringify({t:'pong'}))}catch(e){}true;");
      } catch {}
      pingTimer.current = setTimeout(() => {
        pingTimer.current = null;
        try { if (AppState.currentState !== 'active') return; } catch {}
        reloadWeb();
      }, 4000);
    });
    return () => { try { sub.remove(); } catch {} };
  }, []);

  // Se a pessoa ativou a localização nas Definições e voltou à app, o tutorial
  // do site ainda estava aberto. Aqui fecha-se o tutorial e tenta-se de novo.
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (st) => {
      if (st !== 'active') return;
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (!perm.granted) return;
        startHeadingWatch();
        inject("try{var h=document.getElementById('lochelp');if(h&&h.classList.contains('on')){window.__gpsAsked=false;h.classList.remove('on');locateMe()}}catch(e){}");
      } catch {}
    });
    return () => { try { sub.remove(); } catch {} };
  }, []);

  // As subscrições de GPS do site morrem com a página (reload/erro), senão
  // ficavam a gastar bateria sem ninguém a ler as posições.
  useEffect(() => {
    return () => {
      clearGeoSubs();
      try { headingSub.current?.remove(); } catch {}
      headingSub.current = null;
    };
  }, []);

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data || '{}');
      if (msg.t === 'pong') {
        try { if (pingTimer.current) clearTimeout(pingTimer.current); } catch {}
        pingTimer.current = null;
        return;
      }
      if (msg.t === 'gps-get') {
        handleGeoGet(msg.id, msg.options);
        return;
      }
      if (msg.t === 'gps-watch') {
        handleGeoWatch(msg.id, msg.options);
        return;
      }
      if (msg.t === 'gps-clear') {
        clearGeoWatch(msg.id);
        return;
      }
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
        const state: any = {
          jwt: token,
          userId: u.id || null,
          role: u.role || null,
          name: u.name || u.phone || null,
          tripId: msg.tripId || null,
          online: !!msg.online,
        };
        try { if (u.role === 'DRIVER' && u.id) AsyncStorage.setItem('lg_driver_user_id', u.id).catch(() => {}); } catch {}
        try { const c = u.cats || u.driver?.cats; if (Array.isArray(c)) AsyncStorage.setItem('lg_driver_cats', JSON.stringify(c)).catch(() => {}); } catch {}
        jwtRef.current = token;
        AsyncStorage.setItem('lg_bg_state', JSON.stringify(state)).catch(() => {});
        try { if (u.role === 'DRIVER' && u.id) AsyncStorage.setItem('lg_driver_user_id', u.id).catch(() => {}); } catch {}
      try { const c = u.cats || (u.driver && u.driver.cats); if (Array.isArray(c)) AsyncStorage.setItem('lg_driver_cats', JSON.stringify(c)).catch(() => {}); } catch {}
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
    // Apps de navegação (Waze/Google/Apple Maps), WhatsApp e qualquer site
    // externo abrem na app própria: dentro da WebView prendiam o ecrã no roxo.
    try {
      const u = new URL(url);
      // WhatsApp: abrir directamente a app (whatsapp://) em vez do wa.me web,
      // que dentro da WebView ficava preso no ecrã lilás.
      if (u.hostname === 'wa.me' || u.hostname === 'api.whatsapp.com') {
        const ph = u.searchParams.get('phone') || (u.pathname || '').replace(/[^0-9]/g, '');
        const tx = u.searchParams.get('text') || '';
        let wa = 'whatsapp://send';
        if (ph) wa += '?phone=' + ph + (tx ? '&text=' + encodeURIComponent(tx) : '');
        else if (tx) wa += '?text=' + encodeURIComponent(tx);
        Linking.openURL(wa).catch(() => Linking.openURL(url).catch(() => {}));
        return false;
      }
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        if (u.hostname === 'ladiesgo.pages.dev') return true;
        Linking.openURL(url).catch(() => {});
        return false;
      }
      // Qualquer outro esquema (whatsapp:, waze:, googlemaps:, tel:...) abre na
      // app respectiva. Sem isto a WebView tentava carregá-lo e prendia no roxo.
      Linking.openURL(url).catch(() => {});
      return false;
    } catch {}
    return true;
  };

  // window.open(..., '_blank') não passa pelo onShouldStartLoad; tratamos aqui
  // para os botões de WhatsApp e links externos abrirem na app respectiva.
  const onOpenWindow = (e: { nativeEvent: { targetUrl: string } }) => {
    const url = (e.nativeEvent && e.nativeEvent.targetUrl) || '';
    if (url && onShouldStartLoad({ url })) {
      webRef.current?.injectJavaScript('window.location.href=' + JSON.stringify(url) + ';true;');
    }
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
          geolocationEnabled={false}
          mediaPlaybackRequiresUserAction={false}
          allowsInlineMediaPlayback
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          allowsBackForwardNavigationGestures
          injectedJavaScriptBeforeContentLoaded={GEO_BRIDGE_JS}
          injectedJavaScript={AUTH_BRIDGE_JS}
          onMessage={onMessage}
          onShouldStartLoadWithRequest={onShouldStartLoad}
          onOpenWindow={onOpenWindow}
          onLoadStart={() => { clearGeoSubs(); beginLoading(); }}
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
          onContentProcessDidTerminate={() => { reloadWeb(); }}
          onRenderProcessGone={() => { reloadWeb(); return true; }}
        />
        {loading && !failed && (
          <View style={splash.overlay}>
            <Image source={require('./assets/icon.png')} style={splash.logo} resizeMode="contain" />
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
  logo: { width: 160, height: 160, borderRadius: 32 },
  name: { fontSize: 36, fontWeight: 'bold', color: '#fff', letterSpacing: 1 },
  tagline: { color: '#e3d0ff', fontSize: 16, marginTop: 6, textAlign: 'center', paddingHorizontal: 32 },
});
