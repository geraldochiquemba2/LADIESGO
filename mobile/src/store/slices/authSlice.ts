import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { authApi, usersApi, tripsApi } from '../../services/api';

interface AuthState {
  user: any | null;
  token: string | null;
  loading: boolean;
  error: string | null;
}

const initialState: AuthState = {
  user: null, token: null, loading: false, error: null,
};

// Restore session or create account on the login screen.
// Called with a name from LoginScreen, or without args to restore a session.
export const initAuth = createAsyncThunk('auth/init', async (name?: string) => {
  const token = await AsyncStorage.getItem('accessToken');

  if (token) {
    try {
      const [profileRes, activeTrip] = await Promise.all([
        usersApi.getProfile(),
        tripsApi.getActive().catch(() => ({ data: null })),
      ]);
      return { user: profileRes.data, accessToken: token, activeTrip: activeTrip.data };
    } catch {
      // Stored session is dead (expired/invalid token) — discard it and fall
      // through to a fresh guest, otherwise every API call 401s forever
      await AsyncStorage.removeItem('accessToken');
    }
  }

  const res = await authApi.guest(name);
  const newToken: string = res.data.accessToken;
  await AsyncStorage.setItem('accessToken', newToken);
  return { user: res.data.user, accessToken: newToken, activeTrip: null };
});

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    setUser: (state, action: PayloadAction<any>) => { state.user = action.payload; },
    setSession: (state, action: PayloadAction<{ user: any; accessToken: string }>) => {
      state.user = action.payload.user;
      state.token = action.payload.accessToken;
    },
    logout: (state) => {
      state.user = null;
      state.token = null;
      AsyncStorage.removeItem('accessToken');
    },
    clearError: (state) => { state.error = null; },
  },
  extraReducers: (builder) => {
    builder
      .addCase(initAuth.fulfilled, (state, action) => {
        state.user = action.payload.user;
        state.token = action.payload.accessToken;
      });
  },
});

export const { setUser, setSession, logout, clearError } = authSlice.actions;
export default authSlice.reducer;
