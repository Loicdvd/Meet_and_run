import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  SafeAreaView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as Location from 'expo-location';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { decodePolyline } from './utils/geo';
import { isSupabaseConfigured, supabase } from './services/supabase';

const GOOGLE_MAPS_API_KEY = process.env.EXPO_PUBLIC_GOOGLE_DIRECTIONS_API_KEY || '';

const INITIAL_REGION = {
  latitude: 37.7749,
  longitude: -122.4194,
  latitudeDelta: 0.05,
  longitudeDelta: 0.05
};

const TYPEFACE = Platform.select({
  ios: 'AvenirNext-Regular',
  android: 'sans-serif',
  default: 'System'
});

const TYPEFACE_MEDIUM = Platform.select({
  ios: 'AvenirNext-DemiBold',
  android: 'sans-serif-medium',
  default: 'System'
});

function formatWhen(dateIso) {
  return new Date(dateIso).toLocaleString();
}

function mapPlanRow(row, participantsByRunId, currentUserId) {
  const participantInfo = participantsByRunId.get(row.id) || { count: 0, joined: false };
  const isOwner = row.owner_id === currentUserId;

  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    dateTime: row.date_time,
    distanceKm: Number(row.distance_km || 0),
    points: row.points || [],
    startPoint: row.start_point || null,
    endPoint: row.end_point || null,
    createdAt: row.created_at,
    joined: isOwner ? true : participantInfo.joined,
    participantCount: isOwner ? participantInfo.count + 1 : participantInfo.count
  };
}

function AuthGate({
  mode,
  onModeChange,
  email,
  onEmailChange,
  password,
  onPasswordChange,
  onSubmit,
  isSubmitting,
  authError
}) {
  return (
    <SafeAreaView style={styles.authWrap}>
      <View style={styles.authCard}>
        <Text style={styles.authTitle}>Run Planner</Text>
        <Text style={styles.authSubtitle}>Sign in to create and join runs across devices.</Text>

        <View style={styles.authToggleRow}>
          <Pressable
            style={[styles.authToggle, mode === 'signin' && styles.authToggleActive]}
            onPress={() => onModeChange('signin')}
          >
            <Text style={[styles.authToggleText, mode === 'signin' && styles.authToggleTextActive]}>
              Sign In
            </Text>
          </Pressable>
          <Pressable
            style={[styles.authToggle, mode === 'signup' && styles.authToggleActive]}
            onPress={() => onModeChange('signup')}
          >
            <Text style={[styles.authToggleText, mode === 'signup' && styles.authToggleTextActive]}>
              Sign Up
            </Text>
          </Pressable>
        </View>

        <TextInput
          style={styles.authInput}
          placeholder="Email"
          placeholderTextColor="#7d8c95"
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={onEmailChange}
        />

        <TextInput
          style={styles.authInput}
          placeholder="Password"
          placeholderTextColor="#7d8c95"
          secureTextEntry
          value={password}
          onChangeText={onPasswordChange}
        />

        {!!authError && <Text style={styles.errorText}>{authError}</Text>}

        <Pressable style={styles.authSubmit} onPress={onSubmit} disabled={isSubmitting}>
          {isSubmitting ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text style={styles.authSubmitText}>{mode === 'signin' ? 'Sign In' : 'Create Account'}</Text>
          )}
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function MissingConfig() {
  return (
    <SafeAreaView style={styles.authWrap}>
      <View style={styles.authCard}>
        <Text style={styles.authTitle}>Supabase Not Configured</Text>
        <Text style={styles.authSubtitle}>Add these variables to `.env` then restart Expo:</Text>
        <Text style={styles.configVar}>EXPO_PUBLIC_SUPABASE_URL=...</Text>
        <Text style={styles.configVar}>EXPO_PUBLIC_SUPABASE_ANON_KEY=...</Text>
        <Text style={styles.configVar}>EXPO_PUBLIC_GOOGLE_DIRECTIONS_API_KEY=...</Text>
      </View>
    </SafeAreaView>
  );
}

export default function App() {
  const mapRef = useRef(null);

  const [session, setSession] = useState(null);
  const [isAuthBooting, setIsAuthBooting] = useState(true);
  const [authMode, setAuthMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [isAuthSubmitting, setIsAuthSubmitting] = useState(false);

  const [region, setRegion] = useState(INITIAL_REGION);
  const [location, setLocation] = useState(null);
  const [startPoint, setStartPoint] = useState(null);
  const [endPoint, setEndPoint] = useState(null);
  const [routePoints, setRoutePoints] = useState([]);
  const [routeDistanceKm, setRouteDistanceKm] = useState(0);
  const [title, setTitle] = useState('');
  const [dateTime, setDateTime] = useState(new Date());
  const [showPicker, setShowPicker] = useState(false);
  const [plans, setPlans] = useState([]);
  const [plansError, setPlansError] = useState('');
  const [plansLoading, setPlansLoading] = useState(false);
  const [isRouting, setIsRouting] = useState(false);
  const [routeError, setRouteError] = useState('');

  useEffect(() => {
    let mounted = true;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      const current = await Location.getCurrentPositionAsync({});
      if (!mounted) return;

      setLocation(current.coords);
      setRegion((prev) => ({
        ...prev,
        latitude: current.coords.latitude,
        longitude: current.coords.longitude
      }));
    })();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      setIsAuthBooting(false);
      return () => {};
    }

    let mounted = true;

    supabase.auth.getSession().then(({ data, error }) => {
      if (!mounted) return;
      if (error) {
        setAuthError(error.message);
      }
      setSession(data.session ?? null);
      setIsAuthBooting(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession ?? null);
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const loadRemotePlans = async () => {
    if (!supabase || !session?.user?.id) return;

    setPlansLoading(true);
    setPlansError('');

    try {
      const { data: runRows, error: runsError } = await supabase
        .from('run_plans')
        .select('*')
        .order('date_time', { ascending: true });

      if (runsError) throw runsError;

      const runIds = (runRows || []).map((row) => row.id);
      const participantsByRunId = new Map();

      if (runIds.length > 0) {
        const { data: participantRows, error: participantError } = await supabase
          .from('run_participants')
          .select('run_id,user_id')
          .in('run_id', runIds);

        if (participantError) throw participantError;

        for (const row of participantRows || []) {
          const prev = participantsByRunId.get(row.run_id) || { count: 0, joined: false };
          const next = {
            count: prev.count + 1,
            joined: prev.joined || row.user_id === session.user.id
          };
          participantsByRunId.set(row.run_id, next);
        }
      }

      const mapped = (runRows || []).map((row) => mapPlanRow(row, participantsByRunId, session.user.id));
      setPlans(mapped);
    } catch (err) {
      setPlansError(err.message || 'Failed to load plans from backend.');
    } finally {
      setPlansLoading(false);
    }
  };

  useEffect(() => {
    if (session?.user?.id) {
      void loadRemotePlans();
    } else {
      setPlans([]);
    }
  }, [session?.user?.id]);

  useEffect(() => {
    if (routePoints.length < 2 || !mapRef.current) return;
    mapRef.current.fitToCoordinates(routePoints, {
      edgePadding: { top: 80, right: 80, bottom: 80, left: 80 },
      animated: true
    });
  }, [routePoints]);

  const distanceKm = useMemo(() => {
    if (routePoints.length < 2) return 0;
    return routeDistanceKm;
  }, [routePoints, routeDistanceKm]);

  const plannerStep = useMemo(() => {
    if (!startPoint) return 'Step 1: Tap map to set a start point';
    if (!endPoint) return 'Step 2: Tap map again to set finish';
    if (isRouting) return 'Generating route...';
    if (routePoints.length > 1) return 'Route ready';
    return 'Step 3: Generate route';
  }, [startPoint, endPoint, routePoints.length, isRouting]);

  const canGenerate = !!startPoint && !!endPoint && !isRouting;
  const canSave = !!title.trim() && routePoints.length > 1 && !isRouting;

  const clearRoute = () => {
    setStartPoint(null);
    setEndPoint(null);
    setRoutePoints([]);
    setRouteDistanceKm(0);
    setRouteError('');
  };

  const buildRoute = async (fromPoint = startPoint, toPoint = endPoint) => {
    if (!fromPoint || !toPoint) return;

    setIsRouting(true);
    setRouteError('');

    try {
      if (!GOOGLE_MAPS_API_KEY) {
        setRouteError('Set EXPO_PUBLIC_GOOGLE_DIRECTIONS_API_KEY in .env then restart Expo.');
        return;
      }

      const origin = `${fromPoint.latitude},${fromPoint.longitude}`;
      const destination = `${toPoint.latitude},${toPoint.longitude}`;
      const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${destination}&mode=walking&key=${GOOGLE_MAPS_API_KEY}`;

      const response = await fetch(url);
      const data = await response.json();

      if (data.status && data.status !== 'OK') {
        const details = data.error_message ? ` ${data.error_message}` : '';
        setRouteError(`Directions API error: ${data.status}.${details}`);
        return;
      }

      if (!data.routes || data.routes.length === 0) {
        setRouteError('No route found. Try nearby points on valid streets/paths.');
        return;
      }

      const route = data.routes[0];
      const polyline = route.overview_polyline?.points || '';
      const decoded = decodePolyline(polyline);

      if (decoded.length < 2) {
        setRouteError('Route geometry missing. Try different points.');
        return;
      }

      setRoutePoints(decoded);
      const meters = route.legs?.reduce((sum, leg) => sum + (leg.distance?.value || 0), 0) || 0;
      setRouteDistanceKm(Number((meters / 1000).toFixed(2)));
    } catch (_err) {
      setRouteError('Route generation failed. Check internet and API restrictions.');
    } finally {
      setIsRouting(false);
    }
  };

  const onMapPress = (event) => {
    const coordinate = event.nativeEvent.coordinate;
    setRouteError('');

    if (!startPoint) {
      setStartPoint(coordinate);
      return;
    }

    if (!endPoint) {
      setEndPoint(coordinate);
      void buildRoute(startPoint, coordinate);
      return;
    }

    setStartPoint(coordinate);
    setEndPoint(null);
    setRoutePoints([]);
    setRouteDistanceKm(0);
  };

  const useCurrentLocation = () => {
    if (!location) {
      setRouteError('Current location unavailable. Enable location permissions.');
      return;
    }

    setRouteError('');
    setStartPoint({ latitude: location.latitude, longitude: location.longitude });
    setEndPoint(null);
    setRoutePoints([]);
    setRouteDistanceKm(0);
  };

  const savePlan = async () => {
    if (!canSave || !supabase || !session?.user?.id) return;

    const payload = {
      owner_id: session.user.id,
      title: title.trim(),
      date_time: dateTime.toISOString(),
      distance_km: Number(distanceKm.toFixed(2)),
      points: routePoints,
      start_point: startPoint,
      end_point: endPoint
    };

    const { error } = await supabase.from('run_plans').insert(payload);

    if (error) {
      setPlansError(error.message || 'Could not save this run plan.');
      return;
    }

    setTitle('');
    clearRoute();
    await loadRemotePlans();
  };

  const toggleJoin = async (plan) => {
    if (!supabase || !session?.user?.id) return;
    if (plan.ownerId === session.user.id) return;

    if (plan.joined) {
      const { error } = await supabase
        .from('run_participants')
        .delete()
        .eq('run_id', plan.id)
        .eq('user_id', session.user.id);

      if (error) {
        setPlansError(error.message || 'Could not leave run.');
        return;
      }
    } else {
      const { error } = await supabase.from('run_participants').insert({
        run_id: plan.id,
        user_id: session.user.id
      });

      if (error) {
        setPlansError(error.message || 'Could not join run.');
        return;
      }
    }

    await loadRemotePlans();
  };

  const sharePlan = async (plan) => {
    const text = `${plan.title}\nWhen: ${formatWhen(plan.dateTime)}\nDistance: ${plan.distanceKm} km\n${plan.participantCount} runner(s) joining.`;
    await Share.share({ message: text });
  };

  const onDateChange = (_event, selected) => {
    if (Platform.OS === 'android') {
      setShowPicker(false);
    }
    if (selected) {
      setDateTime(selected);
    }
  };

  const submitAuth = async () => {
    if (!supabase) return;
    setAuthError('');

    if (!email.trim() || !password.trim()) {
      setAuthError('Email and password are required.');
      return;
    }

    setIsAuthSubmitting(true);
    try {
      if (authMode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password
        });
        if (error) throw error;
      } else {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password
        });
        if (error) throw error;

        if (!data.session) {
          setAuthError('Check your inbox and confirm your email, then sign in.');
        }
      }
    } catch (err) {
      setAuthError(err.message || 'Authentication failed.');
    } finally {
      setIsAuthSubmitting(false);
    }
  };

  const signOut = async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
  };

  if (!isSupabaseConfigured) {
    return <MissingConfig />;
  }

  if (isAuthBooting) {
    return (
      <SafeAreaView style={styles.bootWrap}>
        <ActivityIndicator size="large" color="#0f766e" />
      </SafeAreaView>
    );
  }

  if (!session) {
    return (
      <AuthGate
        mode={authMode}
        onModeChange={setAuthMode}
        email={email}
        onEmailChange={setEmail}
        password={password}
        onPasswordChange={setPassword}
        onSubmit={submitAuth}
        isSubmitting={isAuthSubmitting}
        authError={authError}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.mapWrap}>
        <MapView
          ref={mapRef}
          style={styles.map}
          provider="google"
          initialRegion={region}
          onPress={onMapPress}
        >
          {startPoint && <Marker coordinate={startPoint} title="Start" pinColor="#0f766e" />}
          {endPoint && <Marker coordinate={endPoint} title="Finish" pinColor="#f97316" />}
          {routePoints.length > 1 && (
            <Polyline coordinates={routePoints} strokeWidth={5} strokeColor="#0f766e" />
          )}
        </MapView>

        <View style={styles.topOverlay}>
          <View>
            <Text style={styles.overlayTitle}>Run Route Planner</Text>
            <Text style={styles.overlayStep}>{plannerStep}</Text>
          </View>
          <Pressable style={styles.signOutButton} onPress={signOut}>
            <Text style={styles.signOutText}>Sign Out</Text>
          </Pressable>
        </View>

        <View style={styles.bottomOverlay}>
          <View style={styles.metricChip}>
            <Text style={styles.metricLabel}>Distance</Text>
            <Text style={styles.metricValue}>{distanceKm.toFixed(2)} km</Text>
          </View>
          <View style={styles.metricChip}>
            <Text style={styles.metricLabel}>Pins</Text>
            <Text style={styles.metricValue}>{startPoint ? (endPoint ? '2/2' : '1/2') : '0/2'}</Text>
          </View>
        </View>

        {isRouting && (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator size="large" color="#ffffff" />
            <Text style={styles.loadingText}>Generating route...</Text>
          </View>
        )}
      </View>

      <View style={styles.panel}>
        <Text style={styles.sectionTitle}>Plan Run</Text>

        <TextInput
          style={styles.input}
          placeholder="Run title (e.g. River loop)"
          placeholderTextColor="#7d8c95"
          value={title}
          onChangeText={setTitle}
        />

        <View style={styles.primaryActions}>
          <Pressable style={styles.primaryButton} onPress={() => setShowPicker(true)}>
            <Text style={styles.primaryButtonText}>Set Date & Time</Text>
          </Pressable>

          <Pressable
            style={[styles.primaryButton, !canGenerate && styles.disabledButton]}
            onPress={() => buildRoute()}
            disabled={!canGenerate}
          >
            <Text style={styles.primaryButtonText}>Generate Route</Text>
          </Pressable>
        </View>

        <Text style={styles.meta}>{dateTime.toLocaleString()}</Text>

        {showPicker && (
          <DateTimePicker value={dateTime} mode="datetime" onChange={onDateChange} />
        )}

        <View style={styles.secondaryActions}>
          <Pressable style={styles.ghostButton} onPress={useCurrentLocation}>
            <Text style={styles.ghostButtonText}>Use My Location</Text>
          </Pressable>

          <Pressable style={styles.ghostButton} onPress={clearRoute}>
            <Text style={styles.ghostButtonText}>Reset Route</Text>
          </Pressable>
        </View>

        {!!routeError && <Text style={styles.errorText}>{routeError}</Text>}
        {!!plansError && <Text style={styles.errorText}>{plansError}</Text>}

        <Pressable
          style={[styles.saveButton, !canSave && styles.disabledButton]}
          onPress={savePlan}
          disabled={!canSave}
        >
          <Text style={styles.saveButtonText}>Save Plan</Text>
        </Pressable>
      </View>

      <View style={styles.listWrap}>
        <Text style={styles.sectionTitle}>Upcoming Runs</Text>
        {plansLoading && (
          <View style={styles.inlineLoading}>
            <ActivityIndicator color="#0f766e" />
            <Text style={styles.inlineLoadingText}>Syncing runs...</Text>
          </View>
        )}
        <FlatList
          data={plans}
          keyExtractor={(item) => item.id}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={<Text style={styles.empty}>No plans yet. Create your first run.</Text>}
          renderItem={({ item }) => {
            const isOwner = item.ownerId === session.user.id;
            return (
              <View style={styles.card}>
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle}>{item.title}</Text>
                  <View style={item.joined ? styles.joinedPill : styles.openPill}>
                    <Text style={styles.pillText}>{item.joined ? 'Joined' : 'Open'}</Text>
                  </View>
                </View>

                <Text style={styles.cardMeta}>{formatWhen(item.dateTime)}</Text>
                <Text style={styles.cardMeta}>
                  {item.distanceKm} km · {item.participantCount} runner(s)
                </Text>

                <View style={styles.cardActions}>
                  <Pressable
                    style={[
                      styles.cardActionButton,
                      item.joined && !isOwner && styles.cardActionButtonActive,
                      isOwner && styles.disabledButton
                    ]}
                    onPress={() => toggleJoin(item)}
                    disabled={isOwner}
                  >
                    <Text style={styles.cardActionText}>{isOwner ? 'Your Run' : item.joined ? 'Leave' : 'Join'}</Text>
                  </Pressable>

                  <Pressable style={styles.cardActionButton} onPress={() => sharePlan(item)}>
                    <Text style={styles.cardActionText}>Share</Text>
                  </Pressable>
                </View>
              </View>
            );
          }}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  bootWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f2f7f9'
  },
  authWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f2f7f9',
    padding: 16
  },
  authCard: {
    width: '100%',
    maxWidth: 430,
    backgroundColor: '#ffffff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#d6e2e8',
    padding: 16
  },
  authTitle: {
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 24,
    color: '#102d38'
  },
  authSubtitle: {
    marginTop: 6,
    marginBottom: 12,
    fontFamily: TYPEFACE,
    fontSize: 14,
    color: '#506973'
  },
  authToggleRow: {
    flexDirection: 'row',
    backgroundColor: '#edf3f6',
    borderRadius: 10,
    padding: 3,
    marginBottom: 12
  },
  authToggle: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 8
  },
  authToggleActive: {
    backgroundColor: '#0f766e'
  },
  authToggleText: {
    fontFamily: TYPEFACE_MEDIUM,
    color: '#1d4554'
  },
  authToggleTextActive: {
    color: '#ffffff'
  },
  authInput: {
    borderWidth: 1,
    borderColor: '#c8d8df',
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    fontFamily: TYPEFACE,
    fontSize: 14,
    color: '#102d38',
    backgroundColor: '#ffffff',
    marginBottom: 10
  },
  authSubmit: {
    marginTop: 4,
    backgroundColor: '#f97316',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center'
  },
  authSubmitText: {
    color: '#ffffff',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 15
  },
  configVar: {
    fontFamily: TYPEFACE,
    color: '#244957',
    marginTop: 4
  },
  container: {
    flex: 1,
    backgroundColor: '#e8eef1'
  },
  mapWrap: {
    flex: 1.05,
    position: 'relative'
  },
  map: {
    flex: 1
  },
  topOverlay: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(10, 37, 46, 0.86)',
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  overlayTitle: {
    color: '#f8fafc',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 16
  },
  overlayStep: {
    marginTop: 4,
    color: '#d0e3ea',
    fontFamily: TYPEFACE,
    fontSize: 13
  },
  signOutButton: {
    borderWidth: 1,
    borderColor: '#88aebc',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  signOutText: {
    color: '#e2f1f6',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 12
  },
  bottomOverlay: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    flexDirection: 'row',
    gap: 10
  },
  metricChip: {
    flex: 1,
    backgroundColor: 'rgba(248, 250, 252, 0.92)',
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 10
  },
  metricLabel: {
    color: '#4f6871',
    fontFamily: TYPEFACE,
    fontSize: 12
  },
  metricValue: {
    color: '#0b3442',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 16
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(3, 18, 24, 0.35)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  loadingText: {
    marginTop: 8,
    color: '#ffffff',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 14
  },
  panel: {
    backgroundColor: '#f9fbfc',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    marginTop: -6
  },
  sectionTitle: {
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 18,
    color: '#102d38',
    marginBottom: 8
  },
  input: {
    borderWidth: 1,
    borderColor: '#c8d8df',
    borderRadius: 12,
    paddingVertical: 11,
    paddingHorizontal: 12,
    fontFamily: TYPEFACE,
    fontSize: 15,
    color: '#102d38',
    backgroundColor: '#ffffff',
    marginBottom: 10
  },
  primaryActions: {
    flexDirection: 'row',
    gap: 10
  },
  primaryButton: {
    flex: 1,
    backgroundColor: '#0f766e',
    borderRadius: 12,
    paddingVertical: 11,
    alignItems: 'center'
  },
  primaryButtonText: {
    color: '#f8fafc',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 13
  },
  disabledButton: {
    opacity: 0.5
  },
  meta: {
    marginTop: 8,
    marginBottom: 10,
    color: '#4c6672',
    fontFamily: TYPEFACE,
    fontSize: 13
  },
  secondaryActions: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10
  },
  ghostButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#b8ccd5',
    borderRadius: 11,
    paddingVertical: 10,
    alignItems: 'center',
    backgroundColor: '#ffffff'
  },
  ghostButtonText: {
    color: '#184252',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 13
  },
  errorText: {
    color: '#b42318',
    backgroundColor: '#fee4e2',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginBottom: 10,
    fontFamily: TYPEFACE,
    fontSize: 13
  },
  saveButton: {
    backgroundColor: '#f97316',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center'
  },
  saveButtonText: {
    color: '#fff7ed',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 15
  },
  listWrap: {
    flex: 0.95,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8
  },
  inlineLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 8
  },
  inlineLoadingText: {
    color: '#3d606c',
    fontFamily: TYPEFACE,
    fontSize: 13
  },
  empty: {
    color: '#68808b',
    fontFamily: TYPEFACE,
    fontSize: 14,
    paddingVertical: 6
  },
  card: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#d5e1e7',
    borderRadius: 14,
    padding: 12,
    marginBottom: 10
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  cardTitle: {
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 16,
    color: '#123443',
    flex: 1,
    paddingRight: 8
  },
  openPill: {
    backgroundColor: '#d9f0ec',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4
  },
  joinedPill: {
    backgroundColor: '#c7e4ff',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4
  },
  pillText: {
    color: '#0f3a4a',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 12
  },
  cardMeta: {
    marginTop: 4,
    color: '#4f6670',
    fontFamily: TYPEFACE,
    fontSize: 13
  },
  cardActions: {
    marginTop: 10,
    flexDirection: 'row',
    gap: 10
  },
  cardActionButton: {
    flex: 1,
    backgroundColor: '#eaf2f6',
    borderRadius: 10,
    paddingVertical: 9,
    alignItems: 'center'
  },
  cardActionButtonActive: {
    backgroundColor: '#c7e4ff'
  },
  cardActionText: {
    color: '#144558',
    fontFamily: TYPEFACE_MEDIUM,
    fontSize: 13
  }
});
