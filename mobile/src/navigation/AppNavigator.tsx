import React, { useEffect, useRef, useState } from 'react';
import { NavigationContainer, NavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '../store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { initAuth } from '../store/slices/authSlice';

import ConnectingScreen from '../screens/shared/ConnectingScreen';
import LoginScreen from '../screens/shared/LoginScreen';
import ChatScreen from '../screens/shared/ChatScreen';
import ProfileScreen from '../screens/shared/ProfileScreen';
import SettingsScreen from '../screens/shared/SettingsScreen';
import NotificationsScreen from '../screens/shared/NotificationsScreen';

import PassengerHomeScreen from '../screens/passenger/HomeScreen';
import BookRideScreen from '../screens/passenger/BookRideScreen';
import FindingDriverScreen from '../screens/passenger/FindingDriverScreen';
import DriverFoundScreen from '../screens/passenger/DriverFoundScreen';
import TrackDriverScreen from '../screens/passenger/TrackDriverScreen';
import TripCompleteScreen from '../screens/passenger/TripCompleteScreen';
import TripHistoryScreen from '../screens/passenger/TripHistoryScreen';
import RateTripScreen from '../screens/passenger/RateTripScreen';

import DriverHomeScreen from '../screens/driver/HomeScreen';
import DriverRegisterScreen from '../screens/driver/RegisterScreen';
import ActiveTripScreen from '../screens/driver/ActiveTripScreen';
import EarningsScreen from '../screens/driver/EarningsScreen';
import PendingApprovalScreen from '../screens/driver/PendingApprovalScreen';
import DriverTripCompleteScreen from '../screens/driver/TripCompleteScreen';
import PasswordBanner from '../components/PasswordBanner';

const Stack = createNativeStackNavigator();

const headerStyle = {
  headerStyle: { backgroundColor: '#FFD700' },
  headerTintColor: '#1a1a2e',
  headerTitleStyle: { fontWeight: '700' as const },
};

const ACTIVE_STATUSES = ['REQUESTED', 'ACCEPTED', 'DRIVER_ARRIVED', 'IN_PROGRESS'];

export default function AppNavigator() {
  const dispatch = useDispatch<AppDispatch>();
  const { user } = useSelector((s: RootState) => s.auth);
  const { currentTrip } = useSelector((s: RootState) => s.trip);
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null);
  const navRef = useRef<NavigationContainerRef<any>>(null);

  useEffect(() => {
    AsyncStorage.getItem('onboarding_done').then((val) => setOnboardingDone(!!val));
  }, []);

  // On login restore: redirect passenger/driver back to active trip screen
  useEffect(() => {
    if (!currentTrip || !user || !navRef.current) return;
    if (!ACTIVE_STATUSES.includes(currentTrip.status)) return;
    const timeout = setTimeout(() => {
      if (user.role === 'DRIVER') {
        navRef.current?.navigate('ActiveTrip', { trip: currentTrip });
      } else {
        navRef.current?.navigate('TrackDriver');
      }
    }, 300);
    return () => clearTimeout(timeout);
  }, [currentTrip?.id, user?.id]);

  if (onboardingDone === null) return null;

  return (
    <NavigationContainer ref={navRef}>
      <Stack.Navigator screenOptions={headerStyle}>
        {!user ? (
          <Stack.Screen name="Login" options={{ headerShown: false }} component={LoginScreen} />
        ) : user.role === 'DRIVER' ? (
          <>
            <Stack.Screen
              name="DriverHome"
              component={DriverHomeScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="DriverRegister"
              component={DriverRegisterScreen}
              options={{ title: 'Register as Driver' }}
            />
            <Stack.Screen
              name="PendingApproval"
              component={PendingApprovalScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="ActiveTrip"
              component={ActiveTripScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="DriverTripComplete"
              component={DriverTripCompleteScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="DriverEarnings"
              component={EarningsScreen}
              options={{ title: 'My Earnings' }}
            />
            <Stack.Screen
              name="Chat"
              component={ChatScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="Profile"
              component={ProfileScreen}
              options={{ title: 'My Profile' }}
            />
            <Stack.Screen
              name="Settings"
              component={SettingsScreen}
              options={{ title: 'Settings' }}
            />
            <Stack.Screen
              name="Notifications"
              component={NotificationsScreen}
              options={{ title: 'Notifications' }}
            />
          </>
        ) : (
          <>
            <Stack.Screen
              name="PassengerHome"
              component={PassengerHomeScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="DriverRegister"
              component={DriverRegisterScreen}
              options={{ title: 'Become a Driver' }}
            />
            <Stack.Screen
              name="PendingApproval"
              component={PendingApprovalScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="BookRide"
              component={BookRideScreen}
              options={{ title: 'Book a Ride' }}
            />
            <Stack.Screen
              name="FindingDriver"
              component={FindingDriverScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="DriverFound"
              component={DriverFoundScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="TrackDriver"
              component={TrackDriverScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="TripComplete"
              component={TripCompleteScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="TripHistory"
              component={TripHistoryScreen}
              options={{ title: 'Trip History' }}
            />
            <Stack.Screen
              name="RateTrip"
              component={RateTripScreen}
              options={{ title: 'Rate Your Trip' }}
            />
            <Stack.Screen
              name="Chat"
              component={ChatScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="Profile"
              component={ProfileScreen}
              options={{ title: 'My Profile' }}
            />
            <Stack.Screen
              name="Settings"
              component={SettingsScreen}
              options={{ title: 'Settings' }}
            />
            <Stack.Screen
              name="Notifications"
              component={NotificationsScreen}
              options={{ title: 'Notifications' }}
            />
          </>
        )}
      </Stack.Navigator>
      <PasswordBanner />
    </NavigationContainer>
  );
}
